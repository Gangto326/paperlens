import { relative } from 'node:path';
import type {
  ContextDocument,
  ExtractionDocument,
  Manifest,
  PaperState,
  Usage,
} from '@shared/schema';
import { stableStringify } from '../cache/hash';
import { CacheReadError, type PaperCacheStore } from '../cache/paper-cache-store';
import { planChunks, type ChunkerOptions, type PlannedChunk } from '../chunk/chunker';
import { runContextPass } from '../context/context-pass';
import { runConceptResearch, type ResearchBatchReport } from '../research/concept-research';
import type { LlmJobRunner } from '../llm/job';
import { promptVersionOf } from '../prompt/template';
import { CONTEXT_NO_TOOLS_TEMPLATE } from '../prompt/templates';
import { runChunk } from '../translate/chunk-run';

/**
 * 논문 단위 작업 스케줄러(COMMIT_PLAN C2.8, PLAN 9절). 앱 전체에서 한 번에 논문 하나, 요청 하나만 돈다.
 * 순서: 컨텍스트(없으면 1차 패스) → `translating` → 청크를 앞에서부터 하나씩 → `complete` 또는 `complete_with_gaps`.
 * - 쓸 수 있는 컨텍스트가 있으면 다시 만들지 않는다. 완료 청크는 다시 요청하지 않는다(runChunk가 inputHash로 판단).
 * - 로그인·한도 문제가 나면 멈춘다. 상태는 `needs_login`·`waiting_quota`로 남고 다시 시작하면 이어서 한다.
 * - 멈춤 요청은 돌고 있는 요청을 취소하지 않는다. 그 청크가 끝난 뒤 멈추고 상태는 `paused`가 된다.
 * - 실패한 청크가 `maxFailedChunks`개가 되면 남은 청크를 보내지 않고 `failed`로 멈춘다.
 * - 사용자가 아직 번역되지 않은 문장을 고르면 그 청크를 다음 순서로 올린다(C2.10, PLAN 9절).
 *   돌고 있는 요청은 취소하지 않는다. 올린 청크가 끝나면 남은 청크를 원래 순서대로 이어 간다.
 * 청크별 입력·출력 토큰과 시간은 로그와 diagnostics/run-<시각>.json에 남긴다(PLAN 11.2).
 */
export const START_STATES: readonly PaperState[] = [
  'mapping',
  'context_pending',
  'translating',
  'paused',
  'waiting_quota',
  'needs_login',
  'complete_with_gaps',
  'failed',
];

export const DEFAULT_MAX_FAILED_CHUNKS = 3;

export interface ChunkMetric {
  chunkId: string;
  order: number;
  sentences: number;
  estimatedTokens: number;
  outcome: 'complete' | 'reused' | 'failed';
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  elapsedMs: number;
  failureCode: string | null;
}

export type SchedulerEvent =
  | { type: 'started'; pdfSha256: string }
  | { type: 'state'; pdfSha256: string; state: PaperState }
  | {
      type: 'context';
      pdfSha256: string;
      status: 'running' | 'reused' | 'done' | 'failed';
      generationId: string | null;
      message: string | null;
    }
  | {
      /** 개념 카드 조사 단계(PLAN 3.3.1). skipped는 돌 필요가 없거나 조사 런타임이 없는 경우다. */
      type: 'research';
      pdfSha256: string;
      status: 'running' | 'done' | 'skipped' | 'stopped';
      researched: number;
      sources: number;
      message: string | null;
    }
  | { type: 'plan'; pdfSha256: string; generationId: string; chunkIds: string[] }
  | { type: 'chunk_started'; pdfSha256: string; chunkId: string; index: number; total: number }
  | {
      type: 'chunk_finished';
      pdfSha256: string;
      chunkId: string;
      ok: boolean;
      /** 완료한 청크 수(이번에 다시 쓰인 것 포함) */
      completed: number;
      failed: number;
      total: number;
      sentenceIds: string[];
    }
  | { type: 'finished'; pdfSha256: string; outcome: RunOutcome; state: PaperState };

export type RunStopReason =
  | 'complete'
  | 'complete_with_gaps'
  | 'paused'
  | 'needs_login'
  | 'waiting_quota'
  | 'too_many_failures'
  | 'context_failed'
  | 'invalid_state'
  | 'no_document'
  | 'busy';

export interface RunOutcome {
  reason: RunStopReason;
  message: string | null;
  generationId: string | null;
  totalChunks: number;
  completedChunks: number;
  failedChunks: number;
  metrics: ChunkMetric[];
  contextUsage: Usage | null;
  /** 개념 카드 조사 단계의 사용량과 묶음별 기록. 돌지 않았으면 null */
  researchUsage: Usage | null;
  researchBatches: ResearchBatchReport[];
  /** 컨텍스트 시작부터 첫 청크 완료까지. 첫 청크가 이번에 새로 완료됐을 때만 값이 있다. */
  firstTranslationMs: number | null;
  elapsedMs: number;
}

export interface PaperSchedulerDeps {
  store: PaperCacheStore;
  runner: LlmJobRunner;
  provider: string;
  runtimeVersion: () => string;
  chunker?: Partial<ChunkerOptions>;
  /**
   * 개념 카드 조사 방식. 기본은 `none`으로 조사하지 않는다.
   * `builtin_web`은 1차 패스 뒤에 런타임의 내장 검색으로 조사한다. runner에 조사 전용 런타임이 연결돼 있어야 한다.
   */
  research?: 'none' | 'builtin_web';
  maxFailedChunks?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

const compact = (d: Date): string =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

export class PaperScheduler {
  private running: string | null = null;
  private stopRequested = false;
  /** 다음에 먼저 돌릴 청크. 앞이 먼저다. */
  private readonly priority: string[] = [];
  /** 지금 실행의 남은 청크(돌고 있는 것 제외)와 문장 → 청크 대응. 실행 중에만 값이 있다. */
  private pending: PlannedChunk[] = [];
  private chunkOfSentence = new Map<string, string>();
  private readonly listeners = new Set<(event: SchedulerEvent) => void>();
  private readonly log: (line: string) => void;
  private readonly now: () => Date;

  constructor(private readonly deps: PaperSchedulerDeps) {
    this.log = deps.log ?? (() => undefined);
    this.now = deps.now ?? (() => new Date());
  }

  get runningPaper(): string | null {
    return this.running;
  }

  onEvent(listener: (event: SchedulerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 돌고 있는 청크가 끝나면 멈춘다. 돌고 있는 것이 없으면 false. */
  requestStop(): boolean {
    if (this.running === null) return false;
    this.stopRequested = true;
    return true;
  }

  /**
   * 문장이 든 청크 가운데 아직 시작하지 않은 것을 다음 순서로 올린다. 여러 청크면 읽기 순서를 지킨다.
   * 돌고 있거나 이미 끝난 청크, 다른 논문의 문장은 무시한다. 올린 청크 ID를 돌려준다.
   */
  prioritizeSentences(pdfSha256: string, sentenceIds: readonly string[]): string[] {
    if (this.running !== pdfSha256) return [];
    const wanted = new Set<string>();
    for (const id of sentenceIds) {
      const chunkId = this.chunkOfSentence.get(id);
      if (chunkId !== undefined) wanted.add(chunkId);
    }
    const raised = this.pending.filter((c) => wanted.has(c.id)).map((c) => c.id);
    if (raised.length === 0) return [];
    const rest = this.priority.filter((id) => !raised.includes(id));
    this.priority.length = 0;
    this.priority.push(...raised, ...rest);
    this.log(`scheduler 우선 처리 ${raised.join(',')}`);
    return raised;
  }

  private emit(event: SchedulerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.log(`scheduler listener 예외: ${String(err)}`);
      }
    }
  }

  private async setState(pdfSha256: string, state: PaperState): Promise<void> {
    const updated = await this.deps.store.updateManifest(
      pdfSha256,
      (m) => {
        m.state = state;
      },
      this.now(),
    );
    this.emit({ type: 'state', pdfSha256, state: updated.state });
  }

  /** 지금 추출본과 지금 프롬프트로 만든 컨텍스트가 저장돼 있으면 돌려준다. */
  private async usableContext(
    pdfSha256: string,
    manifest: Manifest,
  ): Promise<{ generationId: string; context: ContextDocument; sha256: string } | null> {
    const { store } = this.deps;
    const generationId = manifest.currentGenerationId;
    if (!generationId) return null;
    const info = manifest.generations.find((g) => g.generationId === generationId);
    if (!info || info.extractionRevision !== manifest.currentExtractionRevision) return null;
    if (info.promptVersion !== promptVersionOf(CONTEXT_NO_TOOLS_TEMPLATE)) return null;
    const path = store.generationPath(pdfSha256, generationId, 'context.json');
    const recorded = manifest.files.find(
      (f) => f.path === relative(store.paperDir(pdfSha256), path),
    );
    if (!recorded) return null;
    try {
      const context = await store.readJson('contextDocument', path, recorded.sha256);
      return { generationId, context, sha256: recorded.sha256 };
    } catch (err) {
      if (err instanceof CacheReadError) {
        this.log(`scheduler 저장된 컨텍스트를 쓸 수 없음: ${err.message}`);
        return null;
      }
      throw err;
    }
  }

  async run(pdfSha256: string): Promise<RunOutcome> {
    const t0 = Date.now();
    const outcome = (
      reason: RunStopReason,
      message: string | null,
      extra: Partial<RunOutcome> = {},
    ): RunOutcome => ({
      reason,
      message,
      generationId: null,
      totalChunks: 0,
      completedChunks: 0,
      failedChunks: 0,
      metrics: [],
      contextUsage: null,
      researchUsage: null,
      researchBatches: [],
      firstTranslationMs: null,
      elapsedMs: Date.now() - t0,
      ...extra,
    });
    if (this.running !== null) {
      return outcome('busy', `다른 논문을 처리 중입니다: ${this.running.slice(0, 8)}`);
    }
    this.running = pdfSha256;
    this.stopRequested = false;
    this.emit({ type: 'started', pdfSha256 });
    let result: RunOutcome;
    try {
      result = await this.execute(pdfSha256, t0, outcome);
    } finally {
      this.running = null;
      this.stopRequested = false;
      this.priority.length = 0;
      this.pending = [];
      this.chunkOfSentence = new Map();
    }
    const state = (await this.deps.store.readManifest(pdfSha256)).state;
    this.log(
      `scheduler ${pdfSha256.slice(0, 8)} 끝 reason=${result.reason} state=${state} chunks=${result.completedChunks}/${result.totalChunks} failed=${result.failedChunks} firstTranslation=${String(result.firstTranslationMs)}ms elapsed=${result.elapsedMs}ms`,
    );
    this.emit({ type: 'finished', pdfSha256, outcome: result, state });
    return result;
  }

  private async execute(
    pdfSha256: string,
    t0: number,
    outcome: (r: RunStopReason, m: string | null, e?: Partial<RunOutcome>) => RunOutcome,
  ): Promise<RunOutcome> {
    const { store, runner } = this.deps;
    const manifest = await store.readManifest(pdfSha256);
    if (manifest.state === 'complete') {
      return outcome('complete', '이미 완료된 논문입니다', {
        generationId: manifest.currentGenerationId ?? null,
      });
    }
    if (!START_STATES.includes(manifest.state)) {
      return outcome('invalid_state', `상태 ${manifest.state}에서는 시작할 수 없습니다`);
    }
    const rev = manifest.currentExtractionRevision;
    if (!rev) return outcome('no_document', '추출 revision이 없습니다');
    const documentPath = store.extractionPath(pdfSha256, rev, 'document.json');
    const recorded = manifest.files.find(
      (f) => f.path === relative(store.paperDir(pdfSha256), documentPath),
    );
    let document: ExtractionDocument;
    try {
      document = await store.readJson('extractionDocument', documentPath, recorded?.sha256);
    } catch (err) {
      if (err instanceof CacheReadError) return outcome('no_document', err.message);
      throw err;
    }

    let contextUsage: Usage | null = null;
    let ready = await this.usableContext(pdfSha256, manifest);
    if (ready) {
      this.emit({
        type: 'context',
        pdfSha256,
        status: 'reused',
        generationId: ready.generationId,
        message: null,
      });
    } else {
      // 1차 패스는 mapping·context_pending·needs_login·waiting_quota에서만 시작한다. 그 밖의 시작 상태는 먼저 되돌린다.
      await this.setState(pdfSha256, 'context_pending');
      this.emit({
        type: 'context',
        pdfSha256,
        status: 'running',
        generationId: null,
        message: null,
      });
      const pass = await runContextPass(
        {
          store,
          runner,
          provider: this.deps.provider,
          runtimeVersion: this.deps.runtimeVersion(),
          now: this.now,
          log: this.log,
        },
        { pdfSha256 },
      );
      if (!pass.ok) {
        this.emit({
          type: 'context',
          pdfSha256,
          status: 'failed',
          generationId: null,
          message: pass.message,
        });
        const reason: RunStopReason =
          pass.llmKind === 'needs_login'
            ? 'needs_login'
            : pass.llmKind === 'quota'
              ? 'waiting_quota'
              : 'context_failed';
        return outcome(reason, pass.message, { contextUsage: pass.usage });
      }
      contextUsage = pass.usage;
      const after = await store.readManifest(pdfSha256);
      ready = await this.usableContext(pdfSha256, after);
      if (!ready) return outcome('context_failed', '저장한 컨텍스트를 다시 읽을 수 없습니다');
      this.emit({
        type: 'context',
        pdfSha256,
        status: 'done',
        generationId: ready.generationId,
        message: null,
      });
    }

    let researchUsage: Usage | null = null;
    let researchBatches: ResearchBatchReport[] = [];
    if (this.deps.research === 'builtin_web') {
      this.emit({
        type: 'research',
        pdfSha256,
        status: 'running',
        researched: 0,
        sources: 0,
        message: null,
      });
      const research = await runConceptResearch(
        { store, runner, now: this.now, log: this.log },
        { pdfSha256, generationId: ready.generationId },
      );
      if (research.status === 'done') {
        researchUsage = research.usage;
        researchBatches = research.batches;
        const after = await store.readManifest(pdfSha256);
        ready = await this.usableContext(pdfSha256, after);
        if (!ready) {
          return outcome('context_failed', '조사 뒤 저장한 컨텍스트를 다시 읽을 수 없습니다', {
            contextUsage,
            researchUsage,
            researchBatches,
          });
        }
        this.emit({
          type: 'research',
          pdfSha256,
          status: 'done',
          researched: research.researched,
          sources: research.sources,
          message: null,
        });
      } else if (research.status === 'stopped') {
        researchUsage = research.usage;
        researchBatches = research.batches;
        this.emit({
          type: 'research',
          pdfSha256,
          status: 'stopped',
          researched: 0,
          sources: 0,
          message: research.message,
        });
        if (research.reason === 'needs_login' || research.reason === 'quota') {
          return outcome(
            research.reason === 'quota' ? 'waiting_quota' : 'needs_login',
            research.message,
            { contextUsage, researchUsage, researchBatches },
          );
        }
        // 조사 런타임이 없으면 일반 설명 그대로 번역을 계속한다.
        this.log(`scheduler 개념 조사를 건너뜀: ${research.reason} ${research.message}`);
      } else {
        this.emit({
          type: 'research',
          pdfSha256,
          status: 'skipped',
          researched: 0,
          sources: 0,
          message: research.reason,
        });
      }
    }

    const { generationId, context } = ready;
    await this.setState(pdfSha256, 'translating');
    const plan = planChunks(document, this.deps.chunker);
    // plan 이벤트를 받자마자 우선 처리를 요청할 수 있으므로 이벤트보다 먼저 채운다.
    this.pending = [...plan.chunks];
    this.chunkOfSentence = new Map(
      plan.chunks.flatMap((c) => c.targetSentenceIds.map((id) => [id, c.id] as const)),
    );
    this.emit({
      type: 'plan',
      pdfSha256,
      generationId,
      chunkIds: plan.chunks.map((c) => c.id),
    });
    this.log(
      `scheduler ${pdfSha256.slice(0, 8)} generation=${generationId} chunks=${plan.chunks.length} sentences=${plan.sentenceCount} tokens≈${plan.estimatedTokens}`,
    );

    const metrics: ChunkMetric[] = [];
    const maxFailed = this.deps.maxFailedChunks ?? DEFAULT_MAX_FAILED_CHUNKS;
    let completed = 0;
    let failed = 0;
    let firstTranslationMs: number | null = null;
    let stop: { reason: RunStopReason; message: string | null } | null = null;

    const takeNext = (): PlannedChunk | undefined => {
      while (this.priority.length > 0) {
        const id = this.priority.shift();
        const at = this.pending.findIndex((c) => c.id === id);
        if (at >= 0) return this.pending.splice(at, 1)[0];
      }
      return this.pending.shift();
    };

    for (let chunk = takeNext(); chunk !== undefined; chunk = takeNext()) {
      if (this.stopRequested) {
        stop = { reason: 'paused', message: '요청에 따라 멈췄습니다' };
        break;
      }
      this.emit({
        type: 'chunk_started',
        pdfSha256,
        chunkId: chunk.id,
        index: chunk.order,
        total: plan.chunks.length,
      });
      const path = store.generationPath(pdfSha256, generationId, `chunks/${chunk.id}.json`);
      let previousAttempts = 0;
      if (await store.exists(path)) {
        try {
          previousAttempts = (await store.readJson('chunkDocument', path)).attempts;
        } catch {
          previousAttempts = 0;
        }
      }
      const started = Date.now();
      const run = await runChunk(
        { store, runner, now: this.now, log: this.log },
        {
          pdfSha256,
          generationId,
          document,
          context,
          contextSha256: ready.sha256,
          chunk,
          previousAttempts,
        },
      );
      const metric: ChunkMetric = {
        chunkId: chunk.id,
        order: chunk.order,
        sentences: chunk.targetSentenceIds.length,
        estimatedTokens: chunk.estimatedTokens,
        outcome: run.ok ? (run.reused ? 'reused' : 'complete') : 'failed',
        requests: run.attempts.length,
        inputTokens: run.usage?.inputTokens ?? null,
        outputTokens: run.usage?.outputTokens ?? null,
        reasoningTokens: run.usage?.reasoningTokens ?? null,
        elapsedMs: Date.now() - started,
        failureCode: run.ok ? null : (run.chunk.lastError?.code ?? run.code),
      };
      metrics.push(metric);
      this.log(
        `scheduler chunk ${chunk.id} ${metric.outcome} sentences=${metric.sentences} requests=${metric.requests} in=${String(metric.inputTokens)} out=${String(metric.outputTokens)} elapsed=${metric.elapsedMs}ms`,
      );
      if (run.ok) {
        completed += 1;
        if (!run.reused && firstTranslationMs === null && metrics.length === 1) {
          firstTranslationMs = Date.now() - t0;
        }
      } else {
        failed += 1;
      }
      this.emit({
        type: 'chunk_finished',
        pdfSha256,
        chunkId: chunk.id,
        ok: run.ok,
        completed,
        failed,
        total: plan.chunks.length,
        sentenceIds: run.chunk.results.map((r) => r.id),
      });
      if (!run.ok && (run.llmKind === 'needs_login' || run.llmKind === 'quota')) {
        stop = {
          reason: run.llmKind === 'quota' ? 'waiting_quota' : 'needs_login',
          message: run.message,
        };
        break;
      }
      if (failed >= maxFailed) {
        stop = {
          reason: 'too_many_failures',
          message: `실패한 청크가 ${failed}개라 남은 청크를 보내지 않습니다`,
        };
        break;
      }
    }

    const reason: RunStopReason = stop?.reason ?? (failed > 0 ? 'complete_with_gaps' : 'complete');
    // needs_login·waiting_quota는 runChunk가 이미 상태를 바꿨다.
    if (reason === 'complete' || reason === 'complete_with_gaps') {
      await this.setState(pdfSha256, reason);
    } else if (reason === 'paused') {
      await this.setState(pdfSha256, 'paused');
    } else if (reason === 'too_many_failures') {
      await this.setState(pdfSha256, 'failed');
    } else {
      this.emit({
        type: 'state',
        pdfSha256,
        state: (await store.readManifest(pdfSha256)).state,
      });
    }

    const result = outcome(reason, stop?.message ?? null, {
      generationId,
      totalChunks: plan.chunks.length,
      completedChunks: completed,
      failedChunks: failed,
      metrics,
      contextUsage,
      researchUsage,
      researchBatches,
      firstTranslationMs,
    });
    const at = this.now();
    await store
      .writeText(
        store.diagnosticsPath(pdfSha256, generationId, `run-${compact(at)}.json`),
        `${stableStringify({ ...result, finishedAt: at.toISOString() })}\n`,
      )
      .catch((err: unknown) => this.log(`scheduler 실행 기록 저장 실패: ${String(err)}`));
    return result;
  }
}
