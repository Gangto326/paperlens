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
import { CacheReadError, type PaperCacheStore } from '../cache/paper-cache-store';
import type { LlmJobEvent, LlmJobFailureKind, LlmJobRunner } from '../llm/job';
import { EMPTY_RESEARCH_TRACE } from '../llm/research-trace';
import { addUsage } from '../llm/usage';
import { renderPrompt } from '../prompt/template';
import { CONCEPT_RESEARCH_TEMPLATE } from '../prompt/templates';
import { isRetryableLlmFailure, stateAfterLlmFailure } from '../state/paper-state';
import { SourceRegistry, type ClaimedSource, type RejectedSource } from './source-check';

/**
 * 개념 카드 조사 패스(PLAN 3.3.1, COMMIT_PLAN R4.4). 도구 없는 1차 패스 뒤, 번역 앞에 돈다.
 *
 * - 개념 카드를 몇 개씩 묶어 조사 작업을 보낸다. 작업 하나가 실패해도 나머지는 계속한다.
 *   실패한 묶음의 카드는 1차 패스가 쓴 일반 설명으로 남는다.
 * - 로그인 필요, 한도 초과, 런타임 없음은 패스를 멈춘다. 아무것도 저장하지 않는다. 다음 실행에서 처음부터 다시 한다.
 * - 출처는 그 작업의 검색 기록과 대조해 통과한 것만 저장한다(source-check.ts).
 * - 읽은 자료가 하나라도 붙은 카드는 researchStatus가 researched가 된다.
 * - 끝나면 research.json과 고친 context.json을 저장한다. research.json이 manifest에 있으면 끝난 패스다.
 * - context.json이 바뀌면 그 세대의 청크 입력 해시가 달라진다. 그래서 청크가 이미 있는 세대에서는 돌지 않는다.
 */
export const CONCEPT_RESEARCH_STAGE = 'concept_research';
export const RESEARCH_TIMEOUT_MS = 10 * 60_000;
export const RESEARCH_BATCH_SIZE = 3;

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
  timeoutMs?: number;
  onEvent?: (event: LlmJobEvent) => void;
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
  try {
    context = await store.readJson(
      'contextDocument',
      contextPath,
      manifest.files.find((f) => f.path === rel(contextPath))?.sha256,
    );
  } catch (err) {
    if (!(err instanceof CacheReadError)) throw err;
    return {
      status: 'stopped',
      reason: 'no_context',
      message: `context.json을 읽을 수 없습니다: ${err.message}`,
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

  const registry = new SourceRegistry([], now);
  const updated = new Map<string, Concept>();
  const reports: ResearchBatchReport[] = [];
  let usage = ZERO_USAGE;
  const stamp = compact(now());

  for (const [index, batch] of batchesOf(
    context.concepts,
    options.batchSize ?? RESEARCH_BATCH_SIZE,
  ).entries()) {
    const jobId = `rs_${generationId}_${stamp}_${index + 1}`;
    const rendered = renderPrompt(CONCEPT_RESEARCH_TEMPLATE, {
      inputs: {
        PAPER_CONTEXT: { summary: context.summary, researchQuestion: context.researchQuestion },
        CONCEPTS: batch.map((c) => ({
          id: c.id,
          name: c.name,
          nameKo: c.nameKo ?? null,
          definitionKo: c.definitionKo,
          whyItMatters: c.whyItMatters,
          exampleKo: c.exampleKo ?? '',
        })),
      },
    });
    log(`research ${jobId} 시작 concepts=${batch.map((c) => c.id).join(',')}`);
    const result = await runner.run(
      {
        jobId,
        prompt: rendered.prompt,
        instructions: rendered.instructions,
        outputSchema: CONCEPT_RESEARCH_OUTPUT_SCHEMA,
        research: { kind: 'builtin_web' },
        timeoutMs: options.timeoutMs ?? RESEARCH_TIMEOUT_MS,
      },
      options.onEvent,
    );
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
      const stopping = STOPPING[result.kind];
      if (stopping) {
        const state = await recordFailure(
          deps,
          pdfSha256,
          `llm_${result.kind}`,
          result.message,
          isRetryableLlmFailure(result.kind),
          usage,
          (current) =>
            stateAfterLlmFailure(
              current === 'researching' ? 'context_pending' : current,
              result.kind,
            ),
        );
        return {
          status: 'stopped',
          reason: stopping,
          message: result.message,
          batches: reports,
          usage,
          state,
        };
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

    const byId = new Map(batch.map((c) => [c.id, c]));
    for (const card of output.concepts) {
      const original = byId.get(card.id.trim());
      // 묶음에 없는 id와 두 번 돌려준 id는 버린다.
      if (!original || updated.has(original.id)) continue;
      const checked = registry.check(card.sources, trace, { jobId });
      report.accepted += checked.refs.length + checked.furtherRefs.length;
      report.rejected.push(...checked.rejected);
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
    log(
      `research ${jobId} 완료 queries=${report.queries} searchItems=${report.searchItems} accepted=${report.accepted} rejected=${report.rejected.length} in=${String(result.usage.inputTokens)} out=${String(result.usage.outputTokens)} elapsed=${result.usage.elapsedMs}ms`,
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
  const contextSha = await store.writeJson('contextDocument', contextPath, next);
  const at = now();
  const after = await store.updateManifest(
    pdfSha256,
    (m) => {
      store.recordFile(m, pdfSha256, researchPath, researchSha);
      store.recordFile(m, pdfSha256, contextPath, contextSha);
      m.usage = addUsage(m.usage, usage);
      m.state = 'context_pending';
      for (const report of reports) {
        if (report.ok) continue;
        m.errors.push({
          id: `err_${compact(at)}_${m.errors.length + 1}`,
          stage: CONCEPT_RESEARCH_STAGE,
          code: `batch_${String(report.failure)}`,
          message: `개념 카드 ${report.conceptIds.join(', ')}의 조사가 실패해 일반 설명으로 남겼습니다`,
          retryable: false,
          attempt: 1,
          occurredAt: at.toISOString(),
          nextRetryAt: null,
        });
      }
    },
    at,
  );
  return {
    status: 'done',
    context: next,
    contextSha256: contextSha,
    researched: next.concepts.filter((c) => c.researchStatus === 'researched').length,
    sources: research.sources.length,
    batches: reports,
    usage,
    state: after.state,
  };
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
