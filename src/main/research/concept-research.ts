import { relative } from 'node:path';
import {
  SCHEMA_VERSION,
  type Concept,
  type ContextDocument,
  type Failure,
  type PaperState,
  type ResearchDocument,
  type Usage,
} from '@shared/schema';
import Ajv from 'ajv';
import { sha256Hex, stableStringify } from '../cache/hash';
import { CacheReadError, type PaperCacheStore } from '../cache/paper-cache-store';
import type { LlmJobEvent, LlmJobFailureKind, LlmJobResult, LlmJobRunner } from '../llm/job';
import { EMPTY_RESEARCH_TRACE, standingOf, type ResearchTrace } from '../llm/research-trace';
import { addUsage } from '../llm/usage';
import { promptVersionOf, renderPrompt } from '../prompt/template';
import { CONCEPT_RESEARCH_TEMPLATE } from '../prompt/templates';
import { InflightStore } from '../resume/inflight-store';
import { salvageArrayItems } from '../resume/salvage';
import { isRetryableLlmFailure, stateAfterLlmFailure } from '../state/paper-state';
import { isSelfSource, paperIdentityOf, type PaperIdentity } from './self-source';
import { SourceRegistry, type ClaimedSource, type RejectedSource } from './source-check';

/**
 * 개념 카드 조사 패스(PLAN 3.3.1, COMMIT_PLAN R4.4). 도구 없는 1차 패스 뒤, 번역 앞에 돈다.
 *
 * - 개념 카드를 몇 개씩 묶어 조사 작업을 보낸다. 작업 하나가 실패해도 나머지는 계속한다.
 *   실패한 묶음의 카드는 뜻이 빈 채로 남는다. 뒤의 카드 쓰기 작업(concept-cards.ts)이 검색 없이 채운다.
 * - 묶음은 `concurrency`개까지 동시에 돈다(COMMIT_PLAN M3 P1). 묶음은 서로의 결과를 입력으로 받지 않는다.
 *   결과는 모두 끝난 뒤에 묶음 순서대로 장부에 넣는다. 그래서 출처 번호(src_N)는 끝나는 순서와 무관하다.
 * - 로그인 필요, 한도 초과, 런타임 없음은 패스를 멈춘다. 새 묶음을 보내지 않고 돌던 묶음이 끝나기를 기다린다.
 *   research.json과 context.json은 쓰지 않는다. 패스가 끝나야 쓴다.
 * - 돌던 작업의 보존(COMMIT_PLAN M3 P2): 묶음마다 받은 출력과 검색 기록을 generations/<gid>/inflight/에 둔다.
 *   다시 실행하면 거기서 끝까지 쓰인 카드를 건지고 남은 카드만 묶어 보낸다.
 *   - 입력 해시(조사 지침의 버전과 조사 전 context.json의 해시)가 같은 기록만 쓴다.
 *   - 끝난 작업의 카드는 그대로 받는다. 끊긴 작업의 카드는 그 작업의 검색 기록에 열람한 자료가 있을 때만 받는다.
 *     출처는 같은 작업의 검색 기록과 대조한다. 다른 작업의 검색 기록으로 출처를 살리지 않는다.
 *   - 허용하지 않은 도구를 쓴 작업의 출력은 건지지 않는다.
 *   - 패스가 끝나 결과를 저장하면 기록을 지운다.
 * - 출처는 그 작업의 검색 기록과 대조해 통과한 것만 저장한다(source-check.ts).
 * - 번역 중인 논문 자체는 출처로 저장하지 않는다(self-source.ts). 논문 정보를 읽지 못하면 거르지 않는다.
 * - 읽은 자료가 하나라도 붙은 카드는 researchStatus가 researched가 된다.
 * - 끝나면 research.json과 고친 context.json을 저장한다. research.json이 manifest에 있으면 끝난 패스다.
 * - context.json이 바뀌면 그 세대의 청크 입력 해시가 달라진다. 그래서 청크가 이미 있는 세대에서는 돌지 않는다.
 */
export const CONCEPT_RESEARCH_STAGE = 'concept_research';
export const RESEARCH_TIMEOUT_MS = 10 * 60_000;
export const RESEARCH_BATCH_SIZE = 3;
/** 동시에 도는 조사 묶음 수. 번역 청크의 기본값과 같게 두었다. 조사 묶음으로 잰 값은 아니다. */
export const RESEARCH_CONCURRENCY = 3;

export interface ConceptResearchModelOutput {
  concepts: {
    id: string;
    definitionKo: string;
    whyItMatters: string;
    exampleKo: string;
    sources: ClaimedSource[];
  }[];
}

const str = { type: 'string' } as const;

export const CONCEPT_RESEARCH_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['concepts'],
  properties: {
    concepts: {
      type: 'array',
      description: '입력 CONCEPTS의 카드마다 하나',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'definitionKo', 'whyItMatters', 'exampleKo', 'sources'],
        properties: {
          id: { ...str, description: '입력 카드의 id 그대로' },
          definitionKo: { ...str, description: '뜻' },
          whyItMatters: { ...str, description: '이 논문에서 중요한 이유' },
          exampleKo: { ...str, description: '구체적인 사례. 지어낸 예시는 가상 예시라고 밝힌다' },
          sources: {
            type: 'array',
            description: '이 턴에서 검색 결과로 받았거나 실제로 연 자료. 없으면 빈 배열',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['url', 'title', 'kind', 'language', 'supports'],
              properties: {
                url: { ...str, description: '검색 기록에 있는 주소 그대로' },
                title: str,
                kind: { type: 'string', enum: ['article', 'paper', 'docs', 'video'] },
                language: { ...str, description: '자료의 언어. 예: ko, en' },
                supports: { ...str, description: '이 자료가 뒷받침하는 내용(한국어, 한 문장)' },
              },
            },
          },
        },
      },
    },
  },
} as const;

export interface ConceptResearchDeps {
  store: PaperCacheStore;
  runner: LlmJobRunner;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface ConceptResearchOptions {
  pdfSha256: string;
  generationId: string;
  batchSize?: number;
  /** 동시에 도는 묶음 수. 기본 `RESEARCH_CONCURRENCY`. 1이면 하나씩 돈다. */
  concurrency?: number;
  timeoutMs?: number;
  onEvent?: (event: LlmJobEvent) => void;
  /** 묶음 하나가 끝날 때마다. 끝난 묶음 수(건진 것 포함)와 전체 묶음 수 */
  onProgress?: (done: number, total: number) => void;
}

export interface ResearchBatchReport {
  jobId: string;
  conceptIds: string[];
  ok: boolean;
  failure: LlmJobFailureKind | 'output_shape' | null;
  queries: number;
  searchItems: number;
  failedViews: number;
  accepted: number;
  rejected: RejectedSource[];
  usage: Usage;
}

export type ConceptResearchResult =
  | {
      status: 'done';
      context: ContextDocument;
      contextSha256: string;
      researched: number;
      sources: number;
      /** 앞선 실행에서 남은 것으로 채워 다시 조사하지 않은 카드 수 */
      recovered: number;
      batches: ResearchBatchReport[];
      usage: Usage;
      state: PaperState;
    }
  | {
      /** already_done: 끝난 패스. no_concepts: 카드 없음. has_chunks: 청크가 이미 있는 세대 */
      status: 'skipped';
      reason: 'already_done' | 'no_concepts' | 'has_chunks';
    }
  | {
      status: 'stopped';
      reason: 'needs_login' | 'quota' | 'unavailable' | 'no_context';
      message: string;
      /** no_context로 멈춘 때는 0 */
      recovered: number;
      batches: ResearchBatchReport[];
      usage: Usage;
      state: PaperState;
    };

const ZERO_USAGE: Usage = {
  logicalJobs: 0,
  turnCount: 0,
  reportedModelCalls: null,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  elapsedMs: 0,
};

const STOPPING: Partial<Record<LlmJobFailureKind, 'needs_login' | 'quota' | 'unavailable'>> = {
  needs_login: 'needs_login',
  quota: 'quota',
  unavailable: 'unavailable',
  unsupported_policy: 'unavailable',
};

const compact = (d: Date): string =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

const outputValidator = new Ajv({ allErrors: true, strict: false }).compile(
  CONCEPT_RESEARCH_OUTPUT_SCHEMA,
);
type ModelCard = ConceptResearchModelOutput['concepts'][number];
const cardValidator = new Ajv({ allErrors: true, strict: false }).compile<ModelCard>(
  CONCEPT_RESEARCH_OUTPUT_SCHEMA.properties.concepts.items,
);

export function batchesOf<T>(items: readonly T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

export async function runConceptResearch(
  deps: ConceptResearchDeps,
  options: ConceptResearchOptions,
): Promise<ConceptResearchResult> {
  const { store, runner } = deps;
  const { pdfSha256, generationId } = options;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);

  const manifest = await store.readManifest(pdfSha256);
  const rel = (path: string): string => relative(store.paperDir(pdfSha256), path);
  const contextPath = store.generationPath(pdfSha256, generationId, 'context.json');
  const researchPath = store.generationPath(pdfSha256, generationId, 'research.json');
  if (manifest.files.some((f) => f.path === rel(researchPath))) {
    return { status: 'skipped', reason: 'already_done' };
  }
  const chunkPrefix = rel(store.generationPath(pdfSha256, generationId, 'chunks/x.json')).slice(
    0,
    -'x.json'.length,
  );
  if (manifest.files.some((f) => f.path.startsWith(chunkPrefix))) {
    return { status: 'skipped', reason: 'has_chunks' };
  }

  let context: ContextDocument;
  const contextSha = manifest.files.find((f) => f.path === rel(contextPath))?.sha256;
  try {
    context = await store.readJson('contextDocument', contextPath, contextSha);
  } catch (err) {
    if (!(err instanceof CacheReadError)) throw err;
    return {
      status: 'stopped',
      reason: 'no_context',
      message: `context.json을 읽을 수 없습니다: ${err.message}`,
      recovered: 0,
      batches: [],
      usage: ZERO_USAGE,
      state: manifest.state,
    };
  }
  if (context.concepts.length === 0) return { status: 'skipped', reason: 'no_concepts' };

  await store.updateManifest(
    pdfSha256,
    (m) => {
      m.state = 'researching';
    },
    now(),
  );

  const identity = await readPaperIdentity(store, pdfSha256, manifest.currentExtractionRevision);
  const isSelf = identity
    ? (source: { url: string; title: string }): boolean => isSelfSource(identity, source)
    : undefined;
  // 앞선 실행에서 남은 것을 건진다.
  const inflight = new InflightStore(store, pdfSha256, generationId, { now, log });
  const inputHash = sha256Hex(
    stableStringify({
      promptVersion: promptVersionOf(CONCEPT_RESEARCH_TEMPLATE),
      contextSha256: contextSha ?? null,
    }),
  );
  const known = new Set(context.concepts.map((c) => c.id));
  const cards = new Map<
    string,
    { card: ModelCard; trace: ResearchTrace; jobId: string; report: ResearchBatchReport | null }
  >();
  const usedJobIds = new Set<string>();
  const stale: string[] = [];
  for (const entry of await inflight.list('concept_research')) {
    usedJobIds.add(entry.meta.jobId);
    if (entry.meta.inputHash !== inputHash) {
      stale.push(entry.meta.jobId);
      continue;
    }
    if (entry.meta.outcome === 'forbidden_tool') continue;
    const finished = entry.meta.outcome === 'ok';
    const trace = entry.trace ?? EMPTY_RESEARCH_TRACE;
    let taken = 0;
    for (const item of salvageArrayItems(entry.text, 'concepts')) {
      if (!cardValidator(item)) continue;
      const id = item.id.trim();
      if (!known.has(id) || !entry.meta.targetIds.includes(id) || cards.has(id)) continue;
      // 끊긴 작업의 카드는 열람한 자료가 하나라도 있어야 받는다. 없으면 다시 조사한다.
      const read = item.sources.some(
        (source) => standingOf(trace, source.url) === 'viewed' && !(isSelf?.(source) ?? false),
      );
      if (!finished && !read) continue;
      cards.set(id, { card: item, trace, jobId: entry.meta.jobId, report: null });
      taken += 1;
    }
    if (taken > 0) log(`research 남은 출력 ${entry.meta.jobId}에서 카드 ${taken}개를 건짐`);
  }
  if (stale.length > 0) await inflight.remove(stale);
  const recovered = cards.size;

  const stamp = compact(now());
  const batches = batchesOf(
    context.concepts.filter((c) => !cards.has(c.id)),
    options.batchSize ?? RESEARCH_BATCH_SIZE,
  );
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? RESEARCH_CONCURRENCY));
  const jobIdOf = (index: number): string => {
    const base = `rs_${generationId}_${stamp}_${index + 1}`;
    let jobId = base;
    // 남은 기록과 이름이 겹치면 그 기록을 덮어쓰게 된다. 겹치지 않는 이름을 쓴다.
    for (let n = 2; usedJobIds.has(jobId); n += 1) jobId = `${base}_r${n}`;
    usedJobIds.add(jobId);
    return jobId;
  };

  const results = new Map<number, { jobId: string; result: LlmJobResult }>();
  const queue = [...batches.entries()];
  let halted = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (halted) return;
      const entry = queue.shift();
      if (entry === undefined) return;
      const [index, batch] = entry;
      const jobId = jobIdOf(index);
      const rendered = renderPrompt(CONCEPT_RESEARCH_TEMPLATE, {
        inputs: {
          PAPER_CONTEXT: {
            title: identity?.title ?? null,
            summary: context.summary,
            researchQuestion: context.researchQuestion,
          },
          CONCEPTS: batch.map((c) => ({
            id: c.id,
            name: c.name,
            nameKo: c.nameKo ?? null,
            whyItMatters: c.whyItMatters,
          })),
        },
      });
      log(`research ${jobId} 시작 concepts=${batch.map((c) => c.id).join(',')}`);
      const recorder = await inflight.begin({
        jobId,
        stage: 'concept_research',
        unitId: batch.map((c) => c.id).join('+'),
        attempt: index + 1,
        inputHash,
        targetIds: batch.map((c) => c.id),
        neighborIds: [],
      });
      const result = await runner.run(
        {
          jobId,
          prompt: rendered.prompt,
          instructions: rendered.instructions,
          outputSchema: CONCEPT_RESEARCH_OUTPUT_SCHEMA,
          research: { kind: 'builtin_web' },
          timeoutMs: options.timeoutMs ?? RESEARCH_TIMEOUT_MS,
        },
        (event) => {
          recorder?.onEvent(event);
          options.onEvent?.(event);
        },
      );
      await recorder?.finish(result);
      results.set(index, { jobId, result });
      if (!result.ok && STOPPING[result.kind]) halted = true;
      options.onProgress?.(results.size, batches.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));

  const reports: ResearchBatchReport[] = [];
  let usage = ZERO_USAGE;
  let stopped: { kind: LlmJobFailureKind; message: string } | null = null;

  for (const [index, batch] of batches.entries()) {
    const done = results.get(index);
    // 멈춘 뒤라 보내지 않은 묶음이다.
    if (!done) continue;
    const { jobId, result } = done;
    usage = addUsage(usage, result.usage);
    const report: ResearchBatchReport = {
      jobId,
      conceptIds: batch.map((c) => c.id),
      ok: false,
      failure: null,
      queries: 0,
      searchItems: 0,
      failedViews: 0,
      accepted: 0,
      rejected: [],
      usage: result.usage,
    };
    reports.push(report);

    if (!result.ok) {
      report.failure = result.kind;
      log(`research ${jobId} 실패 kind=${result.kind} ${result.message}`);
      if (STOPPING[result.kind] && stopped === null) {
        stopped = { kind: result.kind, message: result.message };
      }
      continue;
    }
    if (!outputValidator(result.value)) {
      report.failure = 'output_shape';
      log(`research ${jobId} 출력이 스키마와 맞지 않음`);
      continue;
    }
    const output: ConceptResearchModelOutput = result.value;
    const trace = result.research ?? EMPTY_RESEARCH_TRACE;
    report.ok = true;
    report.queries = trace.queries.length;
    report.searchItems = trace.searchItems;
    report.failedViews = trace.failedViews;
    const inBatch = new Set(batch.map((c) => c.id));
    for (const card of output.concepts) {
      const id = card.id.trim();
      // 묶음에 없는 id와 두 번 돌려준 id는 버린다.
      if (!inBatch.has(id) || cards.has(id)) continue;
      cards.set(id, { card, trace, jobId, report });
    }
  }

  if (stopped !== null) {
    const { kind, message } = stopped;
    const state = await recordFailure(
      deps,
      pdfSha256,
      `llm_${kind}`,
      message,
      isRetryableLlmFailure(kind),
      usage,
      (current) =>
        stateAfterLlmFailure(current === 'researching' ? 'context_pending' : current, kind),
    );
    return {
      status: 'stopped',
      reason: STOPPING[kind] ?? 'unavailable',
      message,
      recovered,
      batches: reports,
      usage,
      state,
    };
  }

  // 출처 장부에는 카드 순서대로 넣는다. 출처 번호는 묶음이 끝난 순서나 건진 순서와 무관하다.
  const registry = new SourceRegistry([], now);
  const updated = new Map<string, Concept>();
  for (const original of context.concepts) {
    const found = cards.get(original.id);
    if (!found) continue;
    const { card, trace, jobId, report } = found;
    const checked = registry.check(card.sources, trace, {
      jobId,
      ...(isSelf ? { isSelf } : {}),
    });
    if (report) {
      report.accepted += checked.refs.length + checked.furtherRefs.length;
      report.rejected.push(...checked.rejected);
    }
    const pick = (next: string, previous: string): string =>
      next.trim() === '' ? previous : next.trim();
    const exampleKo = pick(card.exampleKo, original.exampleKo ?? '');
    updated.set(original.id, {
      ...original,
      definitionKo: pick(card.definitionKo, original.definitionKo),
      whyItMatters: pick(card.whyItMatters, original.whyItMatters),
      exampleKo: exampleKo === '' ? null : exampleKo,
      refs: checked.refs,
      furtherRefs: checked.furtherRefs,
      researchStatus: checked.refs.length > 0 ? 'researched' : 'unresolved',
    });
  }
  for (const report of reports) {
    if (!report.ok) continue;
    log(
      `research ${report.jobId} 완료 queries=${report.queries} searchItems=${report.searchItems} accepted=${report.accepted} rejected=${report.rejected.length} in=${String(report.usage.inputTokens)} out=${String(report.usage.outputTokens)} elapsed=${report.usage.elapsedMs}ms`,
    );
  }

  const next: ContextDocument = {
    ...context,
    concepts: context.concepts.map((c) => updated.get(c.id) ?? c),
  };
  const research: ResearchDocument = {
    schemaVersion: SCHEMA_VERSION,
    sources: registry.sources(),
    evidence: [],
  };
  const researchSha = await store.writeJson('researchDocument', researchPath, research);
  const nextSha = await store.writeJson('contextDocument', contextPath, next);
  const at = now();
  const after = await store.updateManifest(
    pdfSha256,
    (m) => {
      store.recordFile(m, pdfSha256, researchPath, researchSha);
      store.recordFile(m, pdfSha256, contextPath, nextSha);
      m.usage = addUsage(m.usage, usage);
      m.state = 'context_pending';
      for (const report of reports) {
        if (report.ok) continue;
        m.errors.push({
          id: `err_${compact(at)}_${m.errors.length + 1}`,
          stage: CONCEPT_RESEARCH_STAGE,
          code: `batch_${String(report.failure)}`,
          message: `개념 카드 ${report.conceptIds.join(', ')}의 조사가 실패했습니다. 검색 없이 쓴 일반 설명으로 채웁니다`,
          retryable: false,
          attempt: 1,
          occurredAt: at.toISOString(),
          nextRetryAt: null,
        });
      }
    },
    at,
  );
  await inflight.remove([...usedJobIds]);
  return {
    status: 'done',
    context: next,
    contextSha256: nextSha,
    recovered,
    researched: next.concepts.filter((c) => c.researchStatus === 'researched').length,
    sources: research.sources.length,
    batches: reports,
    usage,
    state: after.state,
  };
}

export async function readPaperIdentity(
  store: PaperCacheStore,
  pdfSha256: string,
  revision: string | null | undefined,
): Promise<PaperIdentity | null> {
  if (!revision) return null;
  try {
    const document = await store.readJson(
      'extractionDocument',
      store.extractionPath(pdfSha256, revision, 'document.json'),
    );
    return paperIdentityOf(document.paper);
  } catch (err) {
    if (!(err instanceof CacheReadError)) throw err;
    return null;
  }
}

async function recordFailure(
  deps: ConceptResearchDeps,
  pdfSha256: string,
  code: string,
  message: string,
  retryable: boolean,
  usage: Usage,
  nextState: (current: PaperState) => PaperState,
): Promise<PaperState> {
  const at = (deps.now ?? (() => new Date()))();
  const updated = await deps.store.updateManifest(
    pdfSha256,
    (m) => {
      const failure: Failure = {
        id: `err_${compact(at)}_${m.errors.length + 1}`,
        stage: CONCEPT_RESEARCH_STAGE,
        code,
        message,
        retryable,
        attempt: 1,
        occurredAt: at.toISOString(),
        nextRetryAt: null,
      };
      m.errors.push(failure);
      m.usage = addUsage(m.usage, usage);
      m.state = nextState(m.state);
    },
    at,
  );
  return updated.state;
}
