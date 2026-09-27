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
import { CacheReadError, type PaperCacheStore } from '../cache/paper-cache-store';
import type { LlmJobEvent, LlmJobFailureKind, LlmJobRunner } from '../llm/job';
import { addUsage } from '../llm/usage';
import { renderPrompt } from '../prompt/template';
import { CONTEXT_NO_TOOLS_TEMPLATE } from '../prompt/templates';
import {
  canStartContextPass,
  isRetryableLlmFailure,
  stateAfterLlmFailure,
} from '../state/paper-state';
import { buildContextInput } from './context-input';
import { CONTEXT_OUTPUT_SCHEMA, type ContextModelOutput } from './context-output';
import { validateContextOutput, type ContextProblem } from './context-validate';

/**
 * 1차 패스 실행(COMMIT_PLAN C2.3, 도구 없음). document.json → 프롬프트 → 구조화 작업 1회 → 검증 → context.json.
 * 검증을 통과한 컨텍스트만 저장한다. 저장 순서는 PLAN 8.3대로 결과 파일 확정 뒤 manifest 갱신이다.
 * 본문이 `maxInputTokens`(기본 25,000, 근사치)를 넘으면 실행하지 않는다. 긴 논문의 계층형 패스는 M3(C3.1)이다.
 * 실패한 출력을 고쳐 달라는 재요청은 하지 않는다. 호출자가 다시 실행할 수 있다.
 */
export const CONTEXT_MAX_INPUT_TOKENS = 25_000;
export const CONTEXT_TIMEOUT_MS = 10 * 60_000;
export const CONTEXT_STAGE = 'context';

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
  maxInputTokens?: number;
  onEvent?: (event: LlmJobEvent) => void;
}

export type ContextPassFailureCode =
  | 'invalid_state'
  | 'no_document'
  | 'empty_body'
  | 'body_too_long'
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
    };

const compact = (d: Date): string =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

const outputValidator = new Ajv({ allErrors: true, strict: false }).compile(CONTEXT_OUTPUT_SCHEMA);

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
  if (input.estimatedTokens > maxTokens) {
    return stop(
      'body_too_long',
      `본문이 약 ${input.estimatedTokens} 토큰으로 한 번에 처리할 상한 ${maxTokens}을 넘습니다`,
      manifest.state,
    );
  }

  const startedAt = now();
  const taken = new Set(manifest.generations.map((g) => g.generationId));
  let generationId = options.generationId ?? `gen_${compact(startedAt)}`;
  for (let n = 2; taken.has(generationId); n += 1) {
    generationId = `${options.generationId ?? `gen_${compact(startedAt)}`}_${n}`;
  }
  const jobId = options.jobId ?? `ctx_${generationId}`;
  const rendered = renderPrompt(CONTEXT_NO_TOOLS_TEMPLATE, {
    inputs: { PAPER_METADATA: input.metadata, PAPER_BODY: input.body },
  });

  await store.updateManifest(
    pdfSha256,
    (m) => {
      m.state = 'context_pending';
    },
    startedAt,
  );
  log(
    `context ${jobId} 시작 sections=${input.sections.length} sentences=${input.sentenceCount} tokens≈${input.estimatedTokens} prompt=${rendered.promptVersion}`,
  );

  const result = await runner.run(
    {
      jobId,
      prompt: rendered.prompt,
      instructions: rendered.instructions,
      outputSchema: CONTEXT_OUTPUT_SCHEMA,
      research: { kind: 'none' },
      timeoutMs: options.timeoutMs ?? CONTEXT_TIMEOUT_MS,
    },
    options.onEvent,
  );

  const recordFailure = async (
    code: string,
    message: string,
    retryable: boolean,
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
        m.usage = addUsage(m.usage, result.usage);
        m.state = nextState(m.state);
      },
      at,
    );
    return updated.state;
  };

  if (!result.ok) {
    const state = await recordFailure(
      `llm_${result.kind}`,
      result.message,
      isRetryableLlmFailure(result.kind),
      (current) => stateAfterLlmFailure(current, result.kind),
    );
    log(`context ${jobId} 실패 kind=${result.kind} state=${state}`);
    return stop('llm_failed', result.message, state, {
      llmKind: result.kind,
      rawText: result.rawText,
      usage: result.usage,
    });
  }

  // 어댑터가 같은 스키마로 검증했지만, 다른 어댑터로 바뀌어도 이 모듈이 받은 모양을 스스로 확인한다.
  if (!outputValidator(result.value)) {
    const errors = formatAjvErrors(outputValidator.errors);
    const message = `컨텍스트 출력이 스키마와 맞지 않습니다: ${errors.join('; ')}`;
    const state = await recordFailure('context_output_shape', message, true, (s) => s);
    return stop('output_shape', message, state, {
      rawText: result.rawText,
      usage: result.usage,
    });
  }
  const output: ContextModelOutput = result.value;
  const checked = validateContextOutput(output, input);
  if (checked.problems.length > 0) {
    const message = `컨텍스트 검증 실패 ${checked.problems.length}건: ${checked.problems
      .slice(0, 5)
      .map((p) => p.message)
      .join('; ')}`;
    const state = await recordFailure('context_validation', message, true, (s) => s);
    log(`context ${jobId} 검증 실패 ${checked.problems.map((p) => p.code).join(',')}`);
    return stop('validation_failed', message, state, {
      problems: checked.problems,
      rawText: result.rawText,
      usage: result.usage,
    });
  }

  const createdAt = now();
  const trimAll = (items: string[]): string[] => items.map((s) => s.trim()).filter((s) => s !== '');
  const context: ContextDocument = {
    schemaVersion: SCHEMA_VERSION,
    version: 1,
    promptVersion: rendered.promptVersion,
    summary: output.summary.trim(),
    researchQuestion: output.researchQuestion.trim(),
    contributions: trimAll(output.contributions),
    methodOverview: output.methodOverview.trim(),
    mainResults: trimAll(output.mainResults),
    limitations: trimAll(output.limitations),
    glossary: checked.glossary,
    // 조사 도구가 없는 단계다. 배경 개념은 만들지 않고 unresolved에만 남긴다.
    concepts: [],
    sectionDigests: [],
    coverage: checked.coverage.map((c) => ({ ...c, jobId })),
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
        promptVersion: rendered.promptVersion,
        contextVersion: context.version,
        provider: deps.provider,
        runtimeVersion: deps.runtimeVersion,
        modelId: result.model,
        createdAt: createdAt.toISOString(),
      });
      m.currentGenerationId = generationId;
      m.usage = addUsage(m.usage, result.usage);
      m.state = 'context_pending';
    },
    createdAt,
  );
  log(
    `context ${jobId} 저장 glossary=${context.glossary.length} unresolved=${context.unresolved.length} coverage=${context.coverage.length} notes=${checked.notes.length} in=${String(result.usage.inputTokens)} out=${String(result.usage.outputTokens)} elapsed=${result.usage.elapsedMs}ms`,
  );
  return {
    ok: true,
    generationId,
    jobId,
    contextPath,
    context,
    notes: checked.notes,
    usage: result.usage,
    model: result.model,
    state: updated.state,
  };
}
