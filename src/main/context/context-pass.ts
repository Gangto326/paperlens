import { relative } from 'node:path';
import {
  SCHEMA_VERSION,
  formatAjvErrors,
  type ContextDocument,
  type Failure,
  type PaperState,
  type Usage,
} from '@shared/schema';
import Ajv from 'ajv';
import { sha256Hex } from '../cache/hash';
import { CacheReadError, type PaperCacheStore } from '../cache/paper-cache-store';
import type { LlmJobEvent, LlmJobFailureKind, LlmJobRunner } from '../llm/job';
import { addUsage } from '../llm/usage';
import { promptVersionOf, renderPrompt } from '../prompt/template';
import {
  CONTEXT_DIGEST_TEMPLATE,
  CONTEXT_MERGE_TEMPLATE,
  CONTEXT_NO_TOOLS_TEMPLATE,
} from '../prompt/templates';
import { InflightStore } from '../resume/inflight-store';
import {
  canStartContextPass,
  isRetryableLlmFailure,
  stateAfterLlmFailure,
} from '../state/paper-state';
import {
  DIGEST_PART_MAX_TOKENS,
  planParts,
  runDigests,
  type DigestRunResult,
  type PartReport,
} from './context-digest';
import { buildContextInput } from './context-input';
import {
  CONTEXT_MERGE_OUTPUT_SCHEMA,
  CONTEXT_OUTPUT_SCHEMA,
  type ContextMergeModelOutput,
  type ContextModelOutput,
} from './context-output';
import { validateContextOutput, type ContextProblem } from './context-validate';

/**
 * 1차 패스 실행(COMMIT_PLAN C2.3, 도구 없음). document.json → 프롬프트 → 구조화 작업 1회 → 검증 → context.json.
 * 검증을 통과한 컨텍스트만 저장한다. 저장 순서는 PLAN 8.3대로 결과 파일 확정 뒤 manifest 갱신이다.
 * 실패한 출력을 고쳐 달라는 재요청은 하지 않는다. 호출자가 다시 실행할 수 있다.
 *
 * 긴 논문(COMMIT_PLAN C3.1, PLAN 5절): 본문이 `maxInputTokens`(기본 25,000, 근사치)를 넘으면 계층형으로 한다.
 * 1. 본문을 부분으로 나눠 부분마다 섹션 요약을 만든다(context-digest.ts). 부분 작업은 동시에 돈다.
 * 2. 통합 턴이 섹션 요약만 보고 요약·용어집·개념 카드를 만든다. 본문은 보지 않는다.
 * 3. coverage는 모델에게 받지 않고 부분 작업의 장부를 쓴다. 장부가 본문의 모든 문장을 덮는지 다시 검사한다.
 * context.json의 `sectionDigests`에 섹션 요약을, `coverage`의 jobId에 그 범위를 읽은 부분 작업을 남긴다.
 *
 * 돌던 작업의 보존(COMMIT_PLAN M3 P2): 요청의 출력은 generations/ctx_pending_<revision>/inflight/에 남긴다.
 * 세대 id는 컨텍스트를 저장할 때 정해지므로 그 전의 출력은 추출 revision에 묶어 둔다.
 * 긴 논문을 다시 실행하면 끝난 부분은 다시 요청하지 않는다. 한 번에 읽는 1차 패스와 통합 턴은
 * 결과가 통째로 하나라 끊긴 출력에서 건질 것이 없다. 출력은 남기지만 다시 실행하면 처음부터 요청한다.
 */
export const CONTEXT_MAX_INPUT_TOKENS = 25_000;
/** 실측(2026-09-30): 본문 20,326토큰을 한 번에 읽는 데 10분 22초. 10분에서는 실패했다. */
export const CONTEXT_TIMEOUT_MS = 20 * 60_000;
export const CONTEXT_STAGE = 'context';

/** 컨텍스트를 만든 지침의 버전. 긴 논문은 통합 지침과 부분 지침의 버전을 함께 적는다. */
export function contextPromptVersionOf(
  estimatedTokens: number,
  maxInputTokens = CONTEXT_MAX_INPUT_TOKENS,
): string {
  return estimatedTokens > maxInputTokens
    ? `${promptVersionOf(CONTEXT_MERGE_TEMPLATE)}+${promptVersionOf(CONTEXT_DIGEST_TEMPLATE)}`
    : promptVersionOf(CONTEXT_NO_TOOLS_TEMPLATE);
}

/** 컨텍스트를 저장하기 전의 출력을 두는 세대 이름 */
export const pendingGenerationOf = (extractionRevision: string): string =>
  `ctx_pending_${extractionRevision}`;

export interface ContextPassDeps {
  store: PaperCacheStore;
  runner: LlmJobRunner;
  provider: string;
  runtimeVersion: string;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface ContextPassOptions {
  pdfSha256: string;
  jobId?: string;
  generationId?: string;
  timeoutMs?: number;
  /** 본문이 이보다 길면 계층형으로 한다 */
  maxInputTokens?: number;
  /** 계층형에서 한 부분에 담는 본문의 상한 */
  partMaxTokens?: number;
  /** 계층형에서 동시에 도는 부분 작업 수 */
  concurrency?: number;
  onEvent?: (event: LlmJobEvent) => void;
  /** 계층형에서 부분 하나가 끝날 때마다(끝난 부분 수, 전체 부분 수) */
  onProgress?: (done: number, total: number) => void;
}

export type ContextPassFailureCode =
  | 'invalid_state'
  | 'no_document'
  | 'empty_body'
  | 'llm_failed'
  | 'output_shape'
  | 'validation_failed';

export type ContextPassResult =
  | {
      ok: true;
      generationId: string;
      jobId: string;
      contextPath: string;
      context: ContextDocument;
      notes: string[];
      usage: Usage;
      model: string | null;
      state: PaperState;
      /** 긴 논문의 부분 작업 기록. 한 번에 읽었으면 빈 배열 */
      parts: PartReport[];
    }
  | {
      ok: false;
      code: ContextPassFailureCode;
      message: string;
      /** code가 llm_failed일 때 어댑터의 실패 종류 */
      llmKind: LlmJobFailureKind | null;
      problems: ContextProblem[];
      /** 진단용 원래 출력. 받은 것이 없으면 null. */
      rawText: string | null;
      usage: Usage | null;
      state: PaperState | null;
      parts: PartReport[];
    };

const compact = (d: Date): string =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

const outputValidator = new Ajv({ allErrors: true, strict: false }).compile(CONTEXT_OUTPUT_SCHEMA);
const mergeValidator = new Ajv({
  allErrors: true,
  strict: false,
}).compile<ContextMergeModelOutput>(CONTEXT_MERGE_OUTPUT_SCHEMA);

export async function runContextPass(
  deps: ContextPassDeps,
  options: ContextPassOptions,
): Promise<ContextPassResult> {
  const { store, runner } = deps;
  const { pdfSha256 } = options;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const stop = (
    code: ContextPassFailureCode,
    message: string,
    state: PaperState | null,
    extra: Partial<Extract<ContextPassResult, { ok: false }>> = {},
  ): ContextPassResult => ({
    ok: false,
    code,
    message,
    llmKind: null,
    problems: [],
    rawText: null,
    usage: null,
    state,
    parts: [],
    ...extra,
  });

  const manifest = await store.readManifest(pdfSha256);
  if (!canStartContextPass(manifest.state)) {
    return stop(
      'invalid_state',
      `상태 ${manifest.state}에서는 컨텍스트 작업을 시작할 수 없습니다`,
      manifest.state,
    );
  }
  const rev = manifest.currentExtractionRevision;
  if (!rev) return stop('no_document', '추출 revision이 없습니다', manifest.state);
  const documentPath = store.extractionPath(pdfSha256, rev, 'document.json');
  const recorded = manifest.files.find(
    (f) => f.path === relative(store.paperDir(pdfSha256), documentPath),
  );
  let document;
  try {
    document = await store.readJson('extractionDocument', documentPath, recorded?.sha256);
  } catch (err) {
    if (err instanceof CacheReadError) {
      return stop(
        'no_document',
        `document.json을 읽을 수 없습니다: ${err.message}`,
        manifest.state,
      );
    }
    throw err;
  }

  const input = buildContextInput(document);
  if (input.sentenceCount === 0) {
    return stop('empty_body', '본문 문장이 없습니다', manifest.state);
  }
  const maxTokens = options.maxInputTokens ?? CONTEXT_MAX_INPUT_TOKENS;
  const long = input.estimatedTokens > maxTokens;
  const promptVersion = contextPromptVersionOf(input.estimatedTokens, maxTokens);

  const startedAt = now();
  const taken = new Set(manifest.generations.map((g) => g.generationId));
  let generationId = options.generationId ?? `gen_${compact(startedAt)}`;
  for (let n = 2; taken.has(generationId); n += 1) {
    generationId = `${options.generationId ?? `gen_${compact(startedAt)}`}_${n}`;
  }
  const jobId = options.jobId ?? `ctx_${generationId}`;
  const inflight = new InflightStore(store, pdfSha256, pendingGenerationOf(rev), { now, log });

  await store.updateManifest(
    pdfSha256,
    (m) => {
      m.state = 'context_pending';
    },
    startedAt,
  );

  const recordFailure = async (
    code: string,
    message: string,
    retryable: boolean,
    usage: Usage,
    nextState: (current: PaperState) => PaperState,
  ): Promise<PaperState> => {
    const at = now();
    const updated = await store.updateManifest(
      pdfSha256,
      (m) => {
        const failure: Failure = {
          id: `err_${compact(at)}_${m.errors.length + 1}`,
          stage: CONTEXT_STAGE,
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
  };

  let digested: Extract<DigestRunResult, { ok: true }> | null = null;
  let spent: Usage = { logicalJobs: 0, turnCount: 0, elapsedMs: 0 };
  let parts: PartReport[] = [];
  if (long) {
    const planned = planParts(input, options.partMaxTokens ?? DIGEST_PART_MAX_TOKENS);
    log(
      `context ${jobId} 긴 논문 tokens≈${input.estimatedTokens} parts=${planned.length} prompt=${promptVersion}`,
    );
    const digests = await runDigests({
      input,
      parts: planned,
      jobPrefix: jobId,
      extractionRevision: rev,
      inflight,
      runner,
      log,
      ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    spent = digests.usage;
    parts = digests.parts;
    if (!digests.ok) {
      const kind = digests.llmKind;
      const state = await recordFailure(
        kind ? `llm_${kind}` : `context_part_${digests.code}`,
        digests.message,
        kind ? isRetryableLlmFailure(kind) : true,
        spent,
        (current) => (kind ? stateAfterLlmFailure(current, kind) : current),
      );
      log(`context ${jobId} 부분 작업 실패 code=${digests.code} state=${state}`);
      return stop(digests.code, digests.message, state, {
        llmKind: kind,
        problems: digests.problems,
        usage: spent,
        parts,
      });
    }
    digested = digests;
  }

  const sectionTitle = new Map(input.sections.map((s, i) => [s.sectionId, input.body[i]]));
  const rendered = digested
    ? renderPrompt(CONTEXT_MERGE_TEMPLATE, {
        inputs: {
          PAPER_METADATA: input.metadata,
          SECTION_DIGESTS: digested.digests.map((d) => ({
            sectionId: input.aliases.sectionAlias(d.sectionId) ?? d.sectionId,
            title: sectionTitle.get(d.sectionId)?.title ?? '',
            parent: sectionTitle.get(d.sectionId)?.parent ?? null,
            summary: d.summary,
            claims: d.claims,
            termCandidates: d.termCandidates,
            evidenceSentenceIds: d.evidenceSentenceIds.map(
              (id) => input.aliases.sentenceAlias(id) ?? id,
            ),
            unresolved: d.unresolved,
          })),
        },
      })
    : renderPrompt(CONTEXT_NO_TOOLS_TEMPLATE, {
        inputs: { PAPER_METADATA: input.metadata, PAPER_BODY: input.body },
      });
  log(
    `context ${jobId} 시작 sections=${input.sections.length} sentences=${input.sentenceCount} tokens≈${input.estimatedTokens} prompt=${rendered.promptVersion}`,
  );

  const recorder = await inflight.begin({
    jobId,
    stage: 'context',
    unitId: digested ? 'merge' : 'single',
    attempt: 1,
    inputHash: sha256Hex(rendered.prompt),
    targetIds: [],
    neighborIds: [],
  });
  const result = await runner.run(
    {
      jobId,
      prompt: rendered.prompt,
      instructions: rendered.instructions,
      outputSchema: digested ? CONTEXT_MERGE_OUTPUT_SCHEMA : CONTEXT_OUTPUT_SCHEMA,
      research: { kind: 'none' },
      timeoutMs: options.timeoutMs ?? CONTEXT_TIMEOUT_MS,
    },
    (event) => {
      recorder?.onEvent(event);
      options.onEvent?.(event);
    },
  );
  await recorder?.finish(result);
  const usage = addUsage(spent, result.usage);

  if (!result.ok) {
    const state = await recordFailure(
      `llm_${result.kind}`,
      result.message,
      isRetryableLlmFailure(result.kind),
      usage,
      (current) => stateAfterLlmFailure(current, result.kind),
    );
    log(`context ${jobId} 실패 kind=${result.kind} state=${state}`);
    return stop('llm_failed', result.message, state, {
      llmKind: result.kind,
      rawText: result.rawText,
      usage,
      parts,
    });
  }

  // 어댑터가 같은 스키마로 검증했지만, 다른 어댑터로 바뀌어도 이 모듈이 받은 모양을 스스로 확인한다.
  let output: ContextModelOutput;
  if (digested) {
    if (!mergeValidator(result.value)) {
      const errors = formatAjvErrors(mergeValidator.errors);
      const message = `통합 출력이 스키마와 맞지 않습니다: ${errors.join('; ')}`;
      const state = await recordFailure('context_output_shape', message, true, usage, (s) => s);
      return stop('output_shape', message, state, { rawText: result.rawText, usage, parts });
    }
    // coverage는 부분 작업의 장부다. 본문의 모든 문장을 덮는지는 아래 검증이 본다.
    output = {
      ...result.value,
      coverage: digested.coverage.map((c) => ({
        sectionId: input.aliases.sectionAlias(c.sectionId) ?? c.sectionId,
        startSentenceId: input.aliases.sentenceAlias(c.startSentenceId) ?? c.startSentenceId,
        endSentenceId: input.aliases.sentenceAlias(c.endSentenceId) ?? c.endSentenceId,
        status: c.status,
      })),
    };
  } else {
    if (!outputValidator(result.value)) {
      const errors = formatAjvErrors(outputValidator.errors);
      const message = `컨텍스트 출력이 스키마와 맞지 않습니다: ${errors.join('; ')}`;
      const state = await recordFailure('context_output_shape', message, true, usage, (s) => s);
      return stop('output_shape', message, state, { rawText: result.rawText, usage, parts });
    }
    output = result.value;
  }
  const checked = validateContextOutput(output, input);
  if (checked.problems.length > 0) {
    const message = `컨텍스트 검증 실패 ${checked.problems.length}건: ${checked.problems
      .slice(0, 5)
      .map((p) => p.message)
      .join('; ')}`;
    const state = await recordFailure('context_validation', message, true, usage, (s) => s);
    log(`context ${jobId} 검증 실패 ${checked.problems.map((p) => p.code).join(',')}`);
    return stop('validation_failed', message, state, {
      problems: checked.problems,
      rawText: result.rawText,
      usage,
      parts,
    });
  }

  const createdAt = now();
  const trimAll = (items: string[]): string[] => items.map((s) => s.trim()).filter((s) => s !== '');
  const context: ContextDocument = {
    schemaVersion: SCHEMA_VERSION,
    version: 1,
    promptVersion,
    summary: output.summary.trim(),
    researchQuestion: output.researchQuestion.trim(),
    contributions: trimAll(output.contributions),
    methodOverview: output.methodOverview.trim(),
    mainResults: trimAll(output.mainResults),
    limitations: trimAll(output.limitations),
    glossary: checked.glossary,
    // 조사 도구가 없는 단계다. 개념 카드는 목록뿐이고 뜻과 사례는 뒤의 작업이 쓴다(researchStatus unresolved).
    concepts: checked.concepts,
    sectionDigests: digested ? digested.digests : [],
    coverage: digested ? digested.coverage : checked.coverage.map((c) => ({ ...c, jobId })),
    unresolved: trimAll(output.unresolved),
    createdAt: createdAt.toISOString(),
  };
  const contextPath = store.generationPath(pdfSha256, generationId, 'context.json');
  const sha = await store.writeJson('contextDocument', contextPath, context);
  const updated = await store.updateManifest(
    pdfSha256,
    (m) => {
      store.recordFile(m, pdfSha256, contextPath, sha);
      m.generations.push({
        generationId,
        extractionRevision: rev,
        promptVersion,
        contextVersion: context.version,
        provider: deps.provider,
        runtimeVersion: deps.runtimeVersion,
        modelId: result.model,
        createdAt: createdAt.toISOString(),
      });
      m.currentGenerationId = generationId;
      m.usage = addUsage(m.usage, usage);
      m.state = 'context_pending';
    },
    createdAt,
  );
  // 저장이 끝났으므로 남긴 출력은 필요 없다.
  await inflight.remove((await inflight.list('context')).map((e) => e.meta.jobId));
  log(
    `context ${jobId} 저장 glossary=${context.glossary.length} concepts=${context.concepts.length} unresolved=${context.unresolved.length} coverage=${context.coverage.length} notes=${checked.notes.length} digests=${context.sectionDigests.length} in=${String(usage.inputTokens)} out=${String(usage.outputTokens)} elapsed=${usage.elapsedMs}ms`,
  );
  return {
    ok: true,
    generationId,
    jobId,
    contextPath,
    context,
    notes: [...(digested?.notes ?? []), ...checked.notes],
    usage,
    model: result.model,
    state: updated.state,
    parts,
  };
}
