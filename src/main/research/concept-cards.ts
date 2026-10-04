import { relative } from 'node:path';
import type { Concept, ContextDocument, Failure, PaperState, Usage } from '@shared/schema';
import Ajv from 'ajv';
import { CacheReadError, type PaperCacheStore } from '../cache/paper-cache-store';
import type { LlmJobEvent, LlmJobFailureKind, LlmJobResult, LlmJobRunner } from '../llm/job';
import { addUsage } from '../llm/usage';
import { renderPrompt } from '../prompt/template';
import { CONCEPT_CARDS_TEMPLATE } from '../prompt/templates';
import { isRetryableLlmFailure, stateAfterLlmFailure } from '../state/paper-state';
import { batchesOf, readPaperIdentity } from './concept-research';

/**
 * 검색 없는 카드 쓰기(docs/quality-backlog.md Q12). 조사 패스 뒤, 번역 앞에 돈다.
 *
 * 1차 패스는 카드의 목록만 만들고 뜻과 사례는 조사 패스가 쓴다. 조사 패스가 채우지 못한 카드가 남는 경우가 있다.
 * 조사를 끈 설정, 조사 런타임이 없을 때, 조사 묶음이 실패했을 때다. 그 카드의 뜻과 사례를 검색 없이 쓴다.
 * 카드의 researchStatus는 unresolved 그대로다. 화면은 "일반 설명, 출처 미확인"으로 표시한다.
 *
 * - 뜻이 빈 카드만 몇 개씩 묶어 보낸다. 없으면 아무것도 하지 않는다.
 * - 서로 독립적인 묶음은 기본적으로 모두 동시에 시작한다.
 * - 작업 하나가 실패해도 나머지는 계속한다. 실패한 묶음의 카드는 뜻이 빈 채로 남고 화면에는 이름과
 *   "왜 중요한가"만 보인다. 다시 실행하면 그 카드만 다시 보낸다.
 * - 로그인 필요, 한도 초과, 런타임 없음은 새 묶음을 보내지 않는다. 그때까지 쓴 카드는 저장한다.
 * - context.json이 바뀌면 그 세대의 청크 입력 해시가 달라진다. 그래서 청크가 이미 있는 세대에서는 돌지 않는다.
 * - 끊긴 출력에서 카드를 건지지 않는다. 검색이 없어 다시 보내는 값이 싸다.
 */
export const CONCEPT_CARDS_STAGE = 'concept_cards';
export const CARDS_TIMEOUT_MS = 10 * 60_000;
/** 조사 묶음(3)의 두 배. 검색이 없어 카드 하나에 드는 시간이 짧다고 보고 정한 값이다. 재지 않았다. */
export const CARDS_BATCH_SIZE = 6;

export interface ConceptCardsModelOutput {
  concepts: { id: string; definitionKo: string; exampleKo: string }[];
}

const str = { type: 'string' } as const;

export const CONCEPT_CARDS_OUTPUT_SCHEMA = {
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
        required: ['id', 'definitionKo', 'exampleKo'],
        properties: {
          id: { ...str, description: '입력 카드의 id 그대로' },
          definitionKo: { ...str, description: '뜻. 확실하게 쓸 수 없으면 빈 문자열' },
          exampleKo: {
            ...str,
            description: '구체적인 사례. 지어낸 예시는 가상 예시라고 밝힌다. 없으면 빈 문자열',
          },
        },
      },
    },
  },
} as const;

export interface ConceptCardsDeps {
  store: PaperCacheStore;
  runner: LlmJobRunner;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface ConceptCardsOptions {
  pdfSha256: string;
  generationId: string;
  batchSize?: number;
  /** 생략하면 모든 묶음을 동시에 시작한다. 명시한 경우에만 동시 실행 수를 제한한다. */
  concurrency?: number;
  timeoutMs?: number;
  onEvent?: (event: LlmJobEvent) => void;
}

export interface CardsBatchReport {
  jobId: string;
  conceptIds: string[];
  ok: boolean;
  failure: LlmJobFailureKind | 'output_shape' | null;
  /** 뜻을 받은 카드 수 */
  written: number;
  usage: Usage;
}

export type ConceptCardsResult =
  | {
      status: 'done';
      /** 뜻을 새로 쓴 카드 수 */
      written: number;
      /** 보냈지만 뜻이 빈 채로 남은 카드 수(묶음 실패, 모델이 비워 둠) */
      empty: number;
      batches: CardsBatchReport[];
      usage: Usage;
      state: PaperState;
    }
  | {
      /** nothing_to_write: 뜻이 빈 카드 없음. has_chunks: 청크가 이미 있는 세대 */
      status: 'skipped';
      reason: 'nothing_to_write' | 'has_chunks';
    }
  | {
      status: 'stopped';
      reason: 'needs_login' | 'quota' | 'unavailable' | 'no_context';
      message: string;
      /** 멈추기 전에 뜻을 써서 저장한 카드 수 */
      written: number;
      batches: CardsBatchReport[];
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
  CONCEPT_CARDS_OUTPUT_SCHEMA,
);

/** 뜻이 아직 없는 카드. 조사 패스나 앞선 카드 쓰기가 채운 카드는 다시 쓰지 않는다. */
export const needsCardText = (concept: Pick<Concept, 'definitionKo'>): boolean =>
  concept.definitionKo.trim() === '';

export async function runConceptCards(
  deps: ConceptCardsDeps,
  options: ConceptCardsOptions,
): Promise<ConceptCardsResult> {
  const { store, runner } = deps;
  const { pdfSha256, generationId } = options;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);

  const manifest = await store.readManifest(pdfSha256);
  const rel = (path: string): string => relative(store.paperDir(pdfSha256), path);
  const contextPath = store.generationPath(pdfSha256, generationId, 'context.json');

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
      written: 0,
      batches: [],
      usage: ZERO_USAGE,
      state: manifest.state,
    };
  }
  const targets = context.concepts.filter(needsCardText);
  if (targets.length === 0) return { status: 'skipped', reason: 'nothing_to_write' };
  const chunkPrefix = rel(store.generationPath(pdfSha256, generationId, 'chunks/x.json')).slice(
    0,
    -'x.json'.length,
  );
  if (manifest.files.some((f) => f.path.startsWith(chunkPrefix))) {
    return { status: 'skipped', reason: 'has_chunks' };
  }

  const identity = await readPaperIdentity(store, pdfSha256, manifest.currentExtractionRevision);
  const stamp = compact(now());
  const batches = batchesOf(targets, options.batchSize ?? CARDS_BATCH_SIZE);
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? batches.length));

  const results = new Map<number, { jobId: string; result: LlmJobResult }>();
  const queue = [...batches.entries()];
  let halted = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (halted) return;
      const entry = queue.shift();
      if (entry === undefined) return;
      const [index, batch] = entry;
      const jobId = `cc_${generationId}_${stamp}_${index + 1}`;
      const rendered = renderPrompt(CONCEPT_CARDS_TEMPLATE, {
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
      log(`cards ${jobId} 시작 concepts=${batch.map((c) => c.id).join(',')}`);
      const result = await runner.run(
        {
          jobId,
          prompt: rendered.prompt,
          instructions: rendered.instructions,
          outputSchema: CONCEPT_CARDS_OUTPUT_SCHEMA,
          research: { kind: 'none' },
          timeoutMs: options.timeoutMs ?? CARDS_TIMEOUT_MS,
        },
        (event) => options.onEvent?.(event),
      );
      results.set(index, { jobId, result });
      if (!result.ok && STOPPING[result.kind]) halted = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));

  const reports: CardsBatchReport[] = [];
  const texts = new Map<string, { definitionKo: string; exampleKo: string | null }>();
  let usage = ZERO_USAGE;
  let stopped: { kind: LlmJobFailureKind; message: string } | null = null;
  for (const [index, batch] of batches.entries()) {
    const done = results.get(index);
    // 멈춘 뒤라 보내지 않은 묶음이다.
    if (!done) continue;
    const { jobId, result } = done;
    usage = addUsage(usage, result.usage);
    const report: CardsBatchReport = {
      jobId,
      conceptIds: batch.map((c) => c.id),
      ok: false,
      failure: null,
      written: 0,
      usage: result.usage,
    };
    reports.push(report);
    if (!result.ok) {
      report.failure = result.kind;
      log(`cards ${jobId} 실패 kind=${result.kind} ${result.message}`);
      if (STOPPING[result.kind] && stopped === null) {
        stopped = { kind: result.kind, message: result.message };
      }
      continue;
    }
    if (!outputValidator(result.value)) {
      report.failure = 'output_shape';
      log(`cards ${jobId} 출력이 스키마와 맞지 않음`);
      continue;
    }
    const output: ConceptCardsModelOutput = result.value;
    report.ok = true;
    const inBatch = new Set(batch.map((c) => c.id));
    for (const card of output.concepts) {
      const id = card.id.trim();
      const definitionKo = card.definitionKo.trim();
      // 묶음에 없는 id, 두 번 돌려준 id, 뜻을 비워 둔 카드는 받지 않는다.
      if (!inBatch.has(id) || texts.has(id) || definitionKo === '') continue;
      const exampleKo = card.exampleKo.trim();
      texts.set(id, { definitionKo, exampleKo: exampleKo === '' ? null : exampleKo });
      report.written += 1;
    }
    log(
      `cards ${jobId} 완료 written=${report.written}/${batch.length} in=${String(result.usage.inputTokens)} out=${String(result.usage.outputTokens)} elapsed=${result.usage.elapsedMs}ms`,
    );
  }

  const next: ContextDocument = {
    ...context,
    concepts: context.concepts.map((c) => {
      const text = texts.get(c.id);
      return text ? { ...c, ...text } : c;
    }),
  };
  const nextSha =
    texts.size > 0 ? await store.writeJson('contextDocument', contextPath, next) : null;
  const at = now();
  const after = await store.updateManifest(
    pdfSha256,
    (m) => {
      if (nextSha !== null) store.recordFile(m, pdfSha256, contextPath, nextSha);
      m.usage = addUsage(m.usage, usage);
      const push = (code: string, message: string, retryable: boolean): void => {
        const failure: Failure = {
          id: `err_${compact(at)}_${m.errors.length + 1}`,
          stage: CONCEPT_CARDS_STAGE,
          code,
          message,
          retryable,
          attempt: 1,
          occurredAt: at.toISOString(),
          nextRetryAt: null,
        };
        m.errors.push(failure);
      };
      for (const report of reports) {
        // 패스를 멈춘 실패는 아래에서 한 번만 적는다.
        if (report.ok || (report.failure !== null && STOPPING[report.failure as LlmJobFailureKind]))
          continue;
        push(
          `batch_${String(report.failure)}`,
          `개념 카드 ${report.conceptIds.join(', ')}의 뜻을 쓰지 못했습니다`,
          false,
        );
      }
      if (stopped !== null) {
        push(`llm_${stopped.kind}`, stopped.message, isRetryableLlmFailure(stopped.kind));
        m.state = stateAfterLlmFailure(m.state, stopped.kind);
      }
    },
    at,
  );

  if (stopped !== null) {
    return {
      status: 'stopped',
      reason: STOPPING[stopped.kind] ?? 'unavailable',
      message: stopped.message,
      written: texts.size,
      batches: reports,
      usage,
      state: after.state,
    };
  }
  return {
    status: 'done',
    written: texts.size,
    empty: targets.length - texts.size,
    batches: reports,
    usage,
    state: after.state,
  };
}
