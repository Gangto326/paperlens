import { relative } from 'node:path';
import {
  SCHEMA_VERSION,
  formatAjvErrors,
  type ChunkDocument,
  type ContextDocument,
  type ExtractionDocument,
  type Failure,
  type PaperState,
  type Sentence,
  type SentenceResult,
  type Usage,
} from '@shared/schema';
import Ajv from 'ajv';
import { bodySentences, chunkInputHash, type PlannedChunk } from '../chunk/chunker';
import { sha256Hex, stableStringify } from '../cache/hash';
import type { PaperCacheStore } from '../cache/paper-cache-store';
import type { LlmJobEvent, LlmJobFailureKind, LlmJobRunner } from '../llm/job';
import { addUsage } from '../llm/usage';
import { buildAliases, type IdAliases } from '../prompt/aliases';
import { promptVersionOf, renderPrompt } from '../prompt/template';
import {
  TRANSLATE_CHUNK_TEMPLATE,
  TRANSLATE_REPAIR_TEMPLATE,
  TRANSLATE_RESUME_TEMPLATE,
} from '../prompt/templates';
import { InflightStore } from '../resume/inflight-store';
import { salvageArrayItems } from '../resume/salvage';
import { isRetryableLlmFailure, stateAfterLlmFailure } from '../state/paper-state';
import { hasExplanation } from '@shared/schema';
import { buildChunkInputs } from './chunk-input';
import {
  CHUNK_RESULTS_SCHEMA,
  type ChunkModelOutput,
  type ChunkModelSentence,
} from './chunk-output';
import { summarizeIssues, validateChunkOutput, type ChunkIssue } from './chunk-validate';

/**
 * 2차 패스 청크 1개 실행(COMMIT_PLAN C2.5~C2.7, 도구 없음).
 * 시도 순서(PLAN 10절): 첫 요청 → 도구 없는 수정 1회 → 청크를 반으로 나눠 1회 → 실패 표시.
 * - 수정 턴에는 검증에 걸린 문장만 다시 보낸다. 통과한 문장의 결과는 그대로 둔다.
 *   결과는 항상 id로 붙인다. 배열 순서로 다른 문장에 번역을 붙이지 않는다.
 * - 출력이 없거나 시간이 넘은 요청은 수정할 출력이 없으므로 바로 반으로 나눈다.
 * - 로그인·한도·런타임 문제는 다시 요청해도 같으므로 거기서 멈춘다.
 * 완료로 저장하는 조건은 모든 대상 문장이 검증을 통과한 것이다. 실패한 청크에도 통과한 문장의 결과는 남긴다.
 * 실패한 요청의 원래 출력은 generations/<gid>/diagnostics/ 아래에 남긴다.
 *
 * 돌던 작업의 보존과 이어 하기(COMMIT_PLAN M3 P2):
 * - 요청이 도는 동안 받은 출력을 generations/<gid>/inflight/에 둔다(resume/inflight-store.ts).
 *   한도 초과, 로그인 만료, 제한 시간, 앱 종료, 강제 종료에서 남는다.
 * - 다시 실행하면 먼저 남은 것을 건진다. 입력 해시가 같은 것만 쓴다.
 *   저장된 미완료 청크의 결과는 저장할 때 검증을 통과한 문장이고 manifest의 해시로 확인한다.
 *   inflight의 출력은 검증 전의 글이다. 끝까지 쓰인 문장만 골라 검증기에 넣고 통과한 문장만 받는다.
 *   허용하지 않은 도구를 쓴 작업(forbidden_tool)의 출력은 건지지 않는다.
 * - 건진 문장은 다시 요청하지 않는다. 요청을 보내기 전에 청크 파일에 저장한다(상태는 pending).
 * - 남은 문장은 이어 하기 턴으로 요청한다. 끊기기 전 출력의 뒷부분을 함께 준다.
 *   모두 건졌으면 요청 없이 완료로 저장한다.
 * - 청크가 완료되면 그 청크의 inflight 기록을 지운다.
 */
export const CHUNK_TIMEOUT_MS = 15 * 60_000;
export const TRANSLATE_STAGE = 'translate';
export const TRANSLATE_PROMPT_VERSION = promptVersionOf(TRANSLATE_CHUNK_TEMPLATE);
/** 수정 턴에 참고로 넣는 앞선 출력의 최대 글자 수 */
export const PREVIOUS_OUTPUT_LIMIT = 4_000;

export interface ChunkRunDeps {
  store: PaperCacheStore;
  runner: LlmJobRunner;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface ChunkRunOptions {
  pdfSha256: string;
  generationId: string;
  document: ExtractionDocument;
  context: ContextDocument;
  /** context.json 파일의 sha256 */
  contextSha256: string;
  chunk: PlannedChunk;
  /** 이 청크에 이미 쓴 요청 수. 다시 실행할 때 이어서 센다. */
  previousAttempts?: number;
  /** 수정 턴 횟수. 기본 1. 0이면 수정하지 않는다. */
  maxRepairs?: number;
  /** 반으로 나눠 다시 요청할지. 기본 true. */
  allowSplit?: boolean;
  timeoutMs?: number;
  onEvent?: (event: LlmJobEvent) => void;
}

export type ChunkRunFailureCode = 'llm_failed' | 'output_shape' | 'validation_failed';
export type ChunkAttemptKind = 'initial' | 'resume' | 'repair' | 'split';

export interface ChunkAttempt {
  jobId: string;
  kind: ChunkAttemptKind;
  targetCount: number;
  /** 이 요청으로 새로 확정된 문장 수 */
  accepted: number;
  outcome: 'ok' | ChunkRunFailureCode;
  llmKind: LlmJobFailureKind | null;
  issues: ChunkIssue[];
  usage: Usage;
}

export type ChunkRunResult =
  | {
      ok: true;
      /** 저장돼 있던 완료 결과를 그대로 썼으면 true. 모델을 부르지 않았다. */
      reused: boolean;
      chunkPath: string;
      chunk: ChunkDocument;
      /** 저장은 했지만 남긴 경고(number_missing 등) */
      issues: ChunkIssue[];
      attempts: ChunkAttempt[];
      usage: Usage | null;
      state: PaperState;
      /** 앞선 실행에서 남은 것으로 채운 문장 수. 이 문장들은 요청하지 않았다. */
      recovered: number;
    }
  | {
      ok: false;
      code: ChunkRunFailureCode;
      message: string;
      llmKind: LlmJobFailureKind | null;
      /** 마지막 요청의 문제 목록 */
      issues: ChunkIssue[];
      /** 마지막 요청의 원래 출력 */
      rawText: string | null;
      chunkPath: string;
      chunk: ChunkDocument;
      attempts: ChunkAttempt[];
      usage: Usage | null;
      state: PaperState;
      recovered: number;
    };

const compact = (d: Date): string =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
const outputValidator = new Ajv({ allErrors: true, strict: false }).compile(CHUNK_RESULTS_SCHEMA);
const sentenceValidator = new Ajv({ allErrors: true, strict: false }).compile<ChunkModelSentence>(
  CHUNK_RESULTS_SCHEMA.properties.results.items,
);

/** 다시 요청해도 달라지지 않는 실패. 여기서 멈춘다. */
const STOP_KINDS: readonly LlmJobFailureKind[] = [
  'unavailable',
  'needs_login',
  'quota',
  'cancelled',
  'interrupted',
  'transport',
  'duplicate_job',
  'unsupported_policy',
  'invalid_schema',
];
/** 고칠 출력이 있는 실패. 수정 턴 대상이다. */
const REPAIR_KINDS: readonly LlmJobFailureKind[] = ['invalid_json', 'schema_mismatch'];

interface RequestOutcome {
  attempt: ChunkAttempt;
  /** 이 요청에서 검증을 통과한 문장 */
  accepted: SentenceResult[];
  rawText: string | null;
  message: string;
  /** 다음 단계: 끝(모두 통과), 수정, 나누기, 멈춤 */
  next: 'done' | 'repair' | 'split' | 'stop';
}

/** 대상 범위 바로 앞과 뒤의 본문 문장. 나눈 조각에도 같은 규칙으로 문맥을 준다. */
export function neighborsOf(
  body: readonly Sentence[],
  targetIds: readonly string[],
  count: number,
): string[] {
  const position = new Map(body.map((s, i) => [s.id, i]));
  const indexes = targetIds
    .map((id) => position.get(id))
    .filter((i): i is number => i !== undefined);
  if (indexes.length === 0 || count <= 0) return [];
  const first = Math.min(...indexes);
  const last = Math.max(...indexes);
  const own = new Set(targetIds);
  return [
    ...body.slice(Math.max(0, first - count), first),
    ...body.slice(last + 1, last + 1 + count),
  ]
    .map((s) => s.id)
    .filter((id) => !own.has(id));
}

export async function runChunk(
  deps: ChunkRunDeps,
  options: ChunkRunOptions,
): Promise<ChunkRunResult> {
  const { store, runner } = deps;
  const { pdfSha256, generationId, document, context, chunk } = options;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const maxRepairs = options.maxRepairs ?? 1;
  const allowSplit = options.allowSplit ?? true;

  const sentences = new Map(document.sentences.map((s) => [s.id, s]));
  const inputHash = chunkInputHash(chunk, sentences, {
    promptVersion: TRANSLATE_PROMPT_VERSION,
    contextVersion: context.version,
    contextSha256: options.contextSha256,
  });
  const chunkPath = store.generationPath(pdfSha256, generationId, `chunks/${chunk.id}.json`);

  // 완료 청크는 다시 요청하지 않는다(PLAN 8.3). 입력이 달라졌으면 저장된 결과는 지금 입력의 결과가 아니다.
  let unfinished: ChunkDocument | null = null;
  if (await store.exists(chunkPath)) {
    const manifest = await store.readManifest(pdfSha256);
    const recorded = manifest.files.find(
      (f) => f.path === relative(store.paperDir(pdfSha256), chunkPath),
    );
    try {
      const saved = await store.readJson('chunkDocument', chunkPath, recorded?.sha256);
      if (saved.status === 'complete' && saved.inputHash === inputHash) {
        log(`chunk ${chunk.id} 저장된 결과 사용`);
        return {
          ok: true,
          reused: true,
          chunkPath,
          chunk: saved,
          issues: [],
          attempts: [],
          usage: null,
          state: manifest.state,
          recovered: 0,
        };
      }
      // 해시가 manifest와 맞는 미완료 청크만 쓴다. 기록이 없는 파일은 믿지 않는다.
      if (recorded && saved.inputHash === inputHash) unfinished = saved;
    } catch (err) {
      log(`chunk ${chunk.id} 저장된 파일을 쓸 수 없어 다시 실행: ${String(err)}`);
    }
  }

  const aliases: IdAliases = buildAliases(document);
  const body = bodySentences(document).map((b) => b.sentence);
  const neighborCount = Math.ceil(chunk.neighborSentenceIds.length / 2);
  const startedAt = now();
  const attempts: ChunkAttempt[] = [];
  const accepted = new Map<string, SentenceResult>();
  const warnings: ChunkIssue[] = [];
  let usage: Usage = { logicalJobs: 0, turnCount: 0, elapsedMs: 0 };
  let lastJobId: string | null = unfinished?.jobId ?? null;
  const inflight = new InflightStore(store, pdfSha256, generationId, { now, log });
  const conceptIds = new Set(context.concepts.map((c) => c.id));

  const need = (id: string): Sentence => {
    const sentence = sentences.get(id);
    if (!sentence) throw new Error(`청크 ${chunk.id}가 문서에 없는 문장을 가리킵니다: ${id}`);
    return sentence;
  };

  // 앞선 실행에서 남은 것을 건진다.
  const targetSet = new Set(chunk.targetSentenceIds);
  for (const r of unfinished?.results ?? []) {
    if (targetSet.has(r.id)) accepted.set(r.id, r);
  }
  const fromDocument = accepted.size;
  let previousOutput: string | null = null;
  let attemptBase = Math.max(options.previousAttempts ?? 0, unfinished?.attempts ?? 0);
  const stale: string[] = [];
  for (const entry of await inflight.list('translate', chunk.id)) {
    if (entry.meta.inputHash !== inputHash) {
      stale.push(entry.meta.jobId);
      continue;
    }
    attemptBase = Math.max(attemptBase, entry.meta.attempt);
    // 허용하지 않은 도구를 쓴 작업의 출력은 건지지 않는다.
    if (entry.text.trim() === '' || entry.meta.outcome === 'forbidden_tool') continue;
    previousOutput = entry.text;
    const written = salvageArrayItems(entry.text, 'results').filter((item) =>
      sentenceValidator(item),
    );
    const open = new Set(
      entry.meta.targetIds.filter((id) => targetSet.has(id) && !accepted.has(id)),
    );
    const candidates = written.filter((item) => {
      const id = aliases.sentenceId(item.id);
      return id !== undefined && open.has(id);
    });
    if (candidates.length === 0) continue;
    const present = new Set(candidates.map((item) => aliases.sentenceId(item.id)));
    const checked = validateChunkOutput(
      { kind: 'results', results: candidates },
      {
        targets: chunk.targetSentenceIds.filter((id) => present.has(id)).map(need),
        neighbors: entry.meta.neighborIds.filter((id) => sentences.has(id)).map(need),
        toId: (alias) => aliases.sentenceId(alias),
        conceptIds,
      },
    );
    const broken = new Set(
      checked.issues.filter((i) => i.severity === 'fatal').map((i) => i.sentenceId),
    );
    const good = checked.results.filter((r) => !broken.has(r.id));
    for (const r of good) accepted.set(r.id, r);
    log(
      `chunk ${chunk.id} 남은 출력 ${entry.meta.jobId}에서 문장 ${good.length}개를 건짐 (끝까지 쓰인 문장 ${written.length}개, 검증에 걸린 문장 ${candidates.length - good.length}개)`,
    );
  }
  if (stale.length > 0) await inflight.remove(stale);
  const recovered = accepted.size;

  const request = async (
    kind: ChunkAttemptKind,
    targetIds: string[],
    repair?: { issues: ChunkIssue[]; previous: string | null },
  ): Promise<RequestOutcome> => {
    const number = attemptBase + attempts.length + 1;
    const jobId = `tr_${generationId}_${chunk.id}_${number}`;
    lastJobId = jobId;
    const neighborIds =
      kind === 'initial' ? chunk.neighborSentenceIds : neighborsOf(body, targetIds, neighborCount);
    const piece: PlannedChunk = {
      ...chunk,
      targetSentenceIds: targetIds,
      neighborSentenceIds: neighborIds,
    };
    const inputs = buildChunkInputs(document, context, piece, aliases);
    const rendered =
      kind === 'resume'
        ? renderPrompt(TRANSLATE_RESUME_TEMPLATE, {
            inputs: {
              ...inputs,
              PREVIOUS_OUTPUT:
                previousOutput === null ? null : previousOutput.slice(-PREVIOUS_OUTPUT_LIMIT),
            },
          })
        : repair
          ? renderPrompt(TRANSLATE_REPAIR_TEMPLATE, {
              inputs: {
                ...inputs,
                PROBLEMS: repair.issues
                  .filter((i) => i.severity === 'fatal')
                  .map((i) => ({
                    id:
                      i.sentenceId === null ? null : (aliases.sentenceAlias(i.sentenceId) ?? null),
                    code: i.code,
                    detail: i.detail,
                  })),
                PREVIOUS_OUTPUT:
                  repair.previous === null ? null : repair.previous.slice(0, PREVIOUS_OUTPUT_LIMIT),
              },
            })
          : renderPrompt(TRANSLATE_CHUNK_TEMPLATE, { inputs: { ...inputs } });
    log(`chunk ${chunk.id} 요청 ${number} kind=${kind} targets=${targetIds.length}`);
    const recorder = await inflight.begin({
      jobId,
      stage: 'translate',
      unitId: chunk.id,
      attempt: number,
      inputHash,
      targetIds,
      neighborIds,
    });
    const result = await runner.run(
      {
        jobId,
        prompt: rendered.prompt,
        instructions: rendered.instructions,
        outputSchema: CHUNK_RESULTS_SCHEMA,
        research: { kind: 'none' },
        timeoutMs: options.timeoutMs ?? CHUNK_TIMEOUT_MS,
      },
      (event) => {
        recorder?.onEvent(event);
        options.onEvent?.(event);
      },
    );
    await recorder?.finish(result);
    usage = addUsage(usage, result.usage);

    const finish = async (
      outcome: ChunkAttempt['outcome'],
      next: RequestOutcome['next'],
      message: string,
      extra: {
        llmKind?: LlmJobFailureKind;
        issues?: ChunkIssue[];
        accepted?: SentenceResult[];
      } = {},
    ): Promise<RequestOutcome> => {
      const attempt: ChunkAttempt = {
        jobId,
        kind,
        targetCount: targetIds.length,
        accepted: extra.accepted?.length ?? 0,
        outcome,
        llmKind: extra.llmKind ?? null,
        issues: extra.issues ?? [],
        usage: result.usage,
      };
      attempts.push(attempt);
      if (outcome !== 'ok') {
        // 원래 출력을 진단용으로 보존한다(PLAN 10절). 실패해도 작업을 막지 않는다.
        const path = store.diagnosticsPath(pdfSha256, generationId, `${chunk.id}.${number}.json`);
        const diagnostic = {
          chunkId: chunk.id,
          attempt: number,
          jobId,
          kind,
          outcome,
          llmKind: attempt.llmKind,
          message,
          issues: attempt.issues,
          targetSentenceIds: targetIds,
          rawText: result.rawText,
          usage: result.usage,
          occurredAt: now().toISOString(),
        };
        await store
          .writeText(path, `${stableStringify(diagnostic)}\n`)
          .catch((err: unknown) => log(`chunk ${chunk.id} 진단 저장 실패: ${String(err)}`));
      }
      return { attempt, accepted: extra.accepted ?? [], rawText: result.rawText, message, next };
    };

    if (!result.ok) {
      const next = STOP_KINDS.includes(result.kind)
        ? 'stop'
        : REPAIR_KINDS.includes(result.kind)
          ? 'repair'
          : 'split';
      return finish('llm_failed', next, result.message, { llmKind: result.kind });
    }
    if (!outputValidator(result.value)) {
      const errors = formatAjvErrors(outputValidator.errors);
      return finish(
        'output_shape',
        'repair',
        `청크 출력이 스키마와 맞지 않습니다: ${errors.join('; ')}`,
      );
    }
    const output: ChunkModelOutput = result.value;
    const checked = validateChunkOutput(output, {
      targets: targetIds.map(need),
      neighbors: neighborIds.map(need),
      toId: (alias) => aliases.sentenceId(alias),
      conceptIds,
    });
    const broken = new Set(
      checked.issues.filter((i) => i.severity === 'fatal').map((i) => i.sentenceId),
    );
    const good = checked.results.filter((r) => !broken.has(r.id));
    if (checked.ok) {
      return finish('ok', 'done', '', { issues: checked.issues, accepted: good });
    }
    const fatal = checked.issues.filter((i) => i.severity === 'fatal');
    return finish('validation_failed', 'repair', `청크 검증 실패: ${summarizeIssues(fatal)}`, {
      issues: checked.issues,
      accepted: good,
    });
  };

  const take = (outcome: RequestOutcome): void => {
    for (const r of outcome.accepted) accepted.set(r.id, r);
    const ids = new Set(outcome.accepted.map((r) => r.id));
    for (const issue of outcome.attempt.issues) {
      if (issue.severity === 'warning' && issue.sentenceId !== null && ids.has(issue.sentenceId)) {
        warnings.push(issue);
      }
    }
  };
  const remaining = (): string[] => chunk.targetSentenceIds.filter((id) => !accepted.has(id));

  const documentOf = (status: ChunkDocument['status'], at: Date | null): ChunkDocument => {
    const results = chunk.targetSentenceIds
      .map((id) => accepted.get(id))
      .filter((r): r is SentenceResult => r !== undefined);
    return {
      schemaVersion: SCHEMA_VERSION,
      id: chunk.id,
      sectionId: chunk.sectionId,
      sectionIds: chunk.sectionIds,
      targetSentenceIds: chunk.targetSentenceIds,
      neighborSentenceIds: chunk.neighborSentenceIds,
      inputHash,
      contextVersion: context.version,
      status,
      attempts: attemptBase + attempts.length,
      results,
      resultHash: status === 'complete' ? sha256Hex(stableStringify(results)) : null,
      startedAt: startedAt.toISOString(),
      completedAt: status === 'complete' && at ? at.toISOString() : null,
      nextRetryAt: null,
      jobId: lastJobId,
      threadId: null,
      turnId: null,
      lastError: null,
    };
  };

  // inflight에서 건진 문장은 요청을 보내기 전에 저장한다. 이어 하던 요청이 또 끊겨도 남는다.
  if (recovered > fromDocument && remaining().length > 0) {
    const sha = await store.writeJson('chunkDocument', chunkPath, documentOf('pending', null));
    await store.updateManifest(
      pdfSha256,
      (m) => store.recordFile(m, pdfSha256, chunkPath, sha),
      now(),
    );
  }

  let last: RequestOutcome | null = null;
  if (remaining().length > 0) {
    last =
      recovered > 0 || previousOutput !== null
        ? await request('resume', remaining())
        : await request('initial', chunk.targetSentenceIds);
    take(last);
    for (let n = 0; n < maxRepairs && last.next === 'repair' && remaining().length > 0; n += 1) {
      last = await request('repair', remaining(), {
        issues: last.attempt.issues,
        previous: last.rawText,
      });
      take(last);
    }
    if (last.next !== 'stop' && remaining().length > 0 && allowSplit) {
      const rest = remaining();
      const half = Math.ceil(rest.length / 2);
      const pieces = rest.length >= 2 ? [rest.slice(0, half), rest.slice(half)] : [rest];
      for (const piece of pieces) {
        last = await request('split', piece);
        take(last);
        if (last.next === 'stop') break;
      }
    }
  }

  const left = remaining();
  const finishedAt = now();
  const base = documentOf('pending', null);
  const results = base.results;

  const save = async (doc: ChunkDocument, failure: Failure | null): Promise<PaperState> => {
    const sha = await store.writeJson('chunkDocument', chunkPath, doc);
    const llmKind = failure ? (last?.attempt.llmKind ?? null) : null;
    const updated = await store.updateManifest(
      pdfSha256,
      (m) => {
        store.recordFile(m, pdfSha256, chunkPath, sha);
        m.usage = addUsage(m.usage, usage);
        if (failure) m.errors.push(failure);
        if (llmKind) m.state = stateAfterLlmFailure(m.state, llmKind);
      },
      finishedAt,
    );
    return updated.state;
  };

  if (left.length === 0 || last === null) {
    const doc = documentOf('complete', finishedAt);
    const state = await save(doc, null);
    const kept = (await inflight.list('translate', chunk.id)).map((e) => e.meta.jobId);
    await inflight.remove(kept);
    log(
      `chunk ${chunk.id} 완료 results=${results.length} recovered=${recovered} requests=${attempts.map((a) => a.kind).join('+')} warnings=${warnings.length} explained=${results.filter((r) => hasExplanation(r)).length} in=${String(usage.inputTokens)} out=${String(usage.outputTokens)} elapsed=${usage.elapsedMs}ms`,
    );
    return {
      ok: true,
      reused: false,
      chunkPath,
      chunk: doc,
      issues: warnings,
      attempts,
      usage: attempts.length === 0 ? null : usage,
      state,
      recovered,
    };
  }

  const code: ChunkRunFailureCode =
    last.attempt.outcome === 'ok' ? 'validation_failed' : last.attempt.outcome;
  const llmKind = last.attempt.llmKind;
  const firstFatal = last.attempt.issues.find((i) => i.severity === 'fatal');
  const failureCode = llmKind
    ? `llm_${llmKind}`
    : code === 'output_shape'
      ? 'chunk_output_shape'
      : `chunk_${firstFatal?.code ?? 'validation'}`;
  const message = `${last.message} (요청 ${attempts.length}회, 문장 ${chunk.targetSentenceIds.length}개 중 ${left.length}개 미완료)`;
  const failure: Failure = {
    id: `err_${compact(finishedAt)}_${chunk.id}_${base.attempts}`,
    stage: TRANSLATE_STAGE,
    code: failureCode,
    message,
    retryable: llmKind ? isRetryableLlmFailure(llmKind) : true,
    attempt: base.attempts,
    occurredAt: finishedAt.toISOString(),
    nextRetryAt: null,
  };
  const doc: ChunkDocument = { ...base, status: 'failed', lastError: failure };
  const state = await save(doc, failure);
  log(
    `chunk ${chunk.id} 실패 code=${failureCode} recovered=${recovered} requests=${attempts.map((a) => a.kind).join('+')} left=${left.length} state=${state}`,
  );
  return {
    ok: false,
    code,
    message,
    llmKind,
    issues: last.attempt.issues,
    rawText: last.rawText,
    chunkPath,
    chunk: doc,
    attempts,
    usage,
    state,
    recovered,
  };
}
