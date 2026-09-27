import { relative } from 'node:path';
import {
  SCHEMA_VERSION,
  formatAjvErrors,
  type ChunkDocument,
  type ContextDocument,
  type ExtractionDocument,
  type Failure,
  type PaperState,
  type Usage,
} from '@shared/schema';
import Ajv from 'ajv';
import { chunkInputHash, type PlannedChunk } from '../chunk/chunker';
import { sha256Hex, stableStringify } from '../cache/hash';
import type { PaperCacheStore } from '../cache/paper-cache-store';
import type { LlmJobEvent, LlmJobFailureKind, LlmJobRunner } from '../llm/job';
import { addUsage } from '../llm/usage';
import { buildAliases } from '../prompt/aliases';
import { promptVersionOf, renderPrompt } from '../prompt/template';
import { TRANSLATE_CHUNK_TEMPLATE } from '../prompt/templates';
import { isRetryableLlmFailure, stateAfterLlmFailure } from '../state/paper-state';
import { buildChunkInputs } from './chunk-input';
import { CHUNK_RESULTS_SCHEMA, type ChunkModelOutput } from './chunk-output';
import { summarizeIssues, validateChunkOutput, type ChunkIssue } from './chunk-validate';

/**
 * 2차 패스 청크 1개 실행(COMMIT_PLAN C2.5·C2.6, 도구 없음). 프롬프트 → 구조화 작업 1회 → 검증 → chunks/<id>.json.
 * 완료로 저장하는 조건은 검증기(chunk-validate.ts)에 fatal이 없는 것이다.
 * 수정 턴과 청크 축소 재시도는 C2.7이다.
 * 실패한 청크도 파일로 남긴다(status failed, lastError). 이전에 완료된 같은 입력의 결과는 덮어쓰지 않는다.
 */
export const CHUNK_TIMEOUT_MS = 10 * 60_000;
export const TRANSLATE_STAGE = 'translate';
export const TRANSLATE_PROMPT_VERSION = promptVersionOf(TRANSLATE_CHUNK_TEMPLATE);

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
  /** 이번이 몇 번째 시도인지(1부터). */
  attempt?: number;
  jobId?: string;
  timeoutMs?: number;
  onEvent?: (event: LlmJobEvent) => void;
}

export type ChunkRunFailureCode = 'llm_failed' | 'output_shape' | 'validation_failed';

export type ChunkRunResult =
  | {
      ok: true;
      /** 저장돼 있던 완료 결과를 그대로 썼으면 true. 모델을 부르지 않았다. */
      reused: boolean;
      chunkPath: string;
      chunk: ChunkDocument;
      /** 저장은 했지만 남긴 경고(number_missing 등) */
      issues: ChunkIssue[];
      usage: Usage | null;
      state: PaperState;
    }
  | {
      ok: false;
      code: ChunkRunFailureCode;
      message: string;
      llmKind: LlmJobFailureKind | null;
      issues: ChunkIssue[];
      rawText: string | null;
      chunkPath: string;
      chunk: ChunkDocument;
      usage: Usage | null;
      state: PaperState;
    };

const compact = (d: Date): string =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
const outputValidator = new Ajv({ allErrors: true, strict: false }).compile(CHUNK_RESULTS_SCHEMA);

export async function runChunk(
  deps: ChunkRunDeps,
  options: ChunkRunOptions,
): Promise<ChunkRunResult> {
  const { store, runner } = deps;
  const { pdfSha256, generationId, document, context, chunk } = options;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const attempt = options.attempt ?? 1;

  const sentences = new Map(document.sentences.map((s) => [s.id, s]));
  const inputHash = chunkInputHash(chunk, sentences, {
    promptVersion: TRANSLATE_PROMPT_VERSION,
    contextVersion: context.version,
    contextSha256: options.contextSha256,
  });
  const chunkPath = store.generationPath(pdfSha256, generationId, `chunks/${chunk.id}.json`);

  // 완료 청크는 다시 요청하지 않는다(PLAN 8.3). 입력이 달라졌으면 저장된 결과는 지금 입력의 결과가 아니다.
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
          usage: null,
          state: manifest.state,
        };
      }
    } catch (err) {
      log(`chunk ${chunk.id} 저장된 파일을 쓸 수 없어 다시 실행: ${String(err)}`);
    }
  }

  const aliases = buildAliases(document);
  const rendered = renderPrompt(TRANSLATE_CHUNK_TEMPLATE, {
    inputs: { ...buildChunkInputs(document, context, chunk, aliases) },
  });
  const startedAt = now();
  const jobId = options.jobId ?? `tr_${generationId}_${chunk.id}_${attempt}`;
  log(
    `chunk ${chunk.id} 시작 attempt=${attempt} targets=${chunk.targetSentenceIds.length} tokens≈${chunk.estimatedTokens}`,
  );
  const result = await runner.run(
    {
      jobId,
      prompt: rendered.prompt,
      instructions: rendered.instructions,
      outputSchema: CHUNK_RESULTS_SCHEMA,
      research: { kind: 'none' },
      timeoutMs: options.timeoutMs ?? CHUNK_TIMEOUT_MS,
    },
    options.onEvent,
  );

  const base: ChunkDocument = {
    schemaVersion: SCHEMA_VERSION,
    id: chunk.id,
    sectionId: chunk.sectionId,
    sectionIds: chunk.sectionIds,
    targetSentenceIds: chunk.targetSentenceIds,
    neighborSentenceIds: chunk.neighborSentenceIds,
    inputHash,
    contextVersion: context.version,
    status: 'pending',
    attempts: attempt,
    results: [],
    resultHash: null,
    startedAt: startedAt.toISOString(),
    completedAt: null,
    nextRetryAt: null,
    jobId,
    threadId: null,
    turnId: null,
    lastError: null,
  };

  const save = async (
    doc: ChunkDocument,
    failure: Failure | null,
    nextState: (current: PaperState) => PaperState,
  ): Promise<PaperState> => {
    const sha = await store.writeJson('chunkDocument', chunkPath, doc);
    const updated = await store.updateManifest(
      pdfSha256,
      (m) => {
        store.recordFile(m, pdfSha256, chunkPath, sha);
        m.usage = addUsage(m.usage, result.usage);
        if (failure) m.errors.push(failure);
        m.state = nextState(m.state);
      },
      now(),
    );
    return updated.state;
  };

  const failed = async (
    code: ChunkRunFailureCode,
    failureCode: string,
    message: string,
    retryable: boolean,
    extra: { llmKind?: LlmJobFailureKind; issues?: ChunkIssue[] },
  ): Promise<ChunkRunResult> => {
    const at = now();
    const failure: Failure = {
      id: `err_${compact(at)}_${chunk.id}_${attempt}`,
      stage: TRANSLATE_STAGE,
      code: failureCode,
      message,
      retryable,
      attempt,
      occurredAt: at.toISOString(),
      nextRetryAt: null,
    };
    const doc: ChunkDocument = { ...base, status: 'failed', lastError: failure };
    const llmKind = extra.llmKind ?? null;
    const state = await save(doc, failure, (current) =>
      llmKind ? stateAfterLlmFailure(current, llmKind) : current,
    );
    log(`chunk ${chunk.id} 실패 code=${failureCode} state=${state}`);
    return {
      ok: false,
      code,
      message,
      llmKind,
      issues: extra.issues ?? [],
      rawText: result.rawText,
      chunkPath,
      chunk: doc,
      usage: result.usage,
      state,
    };
  };

  if (!result.ok) {
    return failed(
      'llm_failed',
      `llm_${result.kind}`,
      result.message,
      isRetryableLlmFailure(result.kind),
      { llmKind: result.kind },
    );
  }
  if (!outputValidator(result.value)) {
    const errors = formatAjvErrors(outputValidator.errors);
    return failed(
      'output_shape',
      'chunk_output_shape',
      `청크 출력이 스키마와 맞지 않습니다: ${errors.join('; ')}`,
      true,
      {},
    );
  }
  const output: ChunkModelOutput = result.value;
  const checked = validateChunkOutput(output, {
    targets: chunk.targetSentenceIds.map((id) => sentences.get(id)).filter((s) => s !== undefined),
    neighbors: chunk.neighborSentenceIds
      .map((id) => sentences.get(id))
      .filter((s) => s !== undefined),
    toId: (alias) => aliases.sentenceId(alias),
  });
  if (!checked.ok) {
    const fatal = checked.issues.filter((i) => i.severity === 'fatal');
    return failed(
      'validation_failed',
      `chunk_${fatal[0]?.code ?? 'validation'}`,
      `청크 검증 실패: ${summarizeIssues(fatal)}`,
      true,
      { issues: checked.issues },
    );
  }
  const results = checked.results;
  const doc: ChunkDocument = {
    ...base,
    status: 'complete',
    results,
    resultHash: sha256Hex(stableStringify(results)),
    completedAt: now().toISOString(),
  };
  const state = await save(doc, null, (current) => current);
  log(
    `chunk ${chunk.id} 완료 results=${results.length} warnings=${checked.issues.length} notes=${results.filter((r) => r.note !== '').length} in=${String(result.usage.inputTokens)} out=${String(result.usage.outputTokens)} elapsed=${result.usage.elapsedMs}ms`,
  );
  return {
    ok: true,
    reused: false,
    chunkPath,
    chunk: doc,
    issues: checked.issues,
    usage: result.usage,
    state,
  };
}
