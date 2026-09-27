import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextDocument, ExtractionDocument, Usage } from '@shared/schema';
import { sampleContext } from '@shared/schema/fixtures';
import { PaperCacheStore } from '../cache/paper-cache-store';
import { planChunks, type PlannedChunk } from '../chunk/chunker';
import {
  TINY_SHA,
  TINY_TEI,
  tinyFonts,
  tinyItems,
  tinyPages,
} from '../extract/__fixtures__/tiny-paper';
import { buildAndSaveDocument } from '../extract/document-store';
import { saveTextItems } from '../extract/text-items-store';
import type { LlmJobFailureKind, LlmJobRequest, LlmJobResult, LlmJobRunner } from '../llm/job';
import { saveOriginalTei } from '../parser/grobid-fulltext';
import { INPUT_PREAMBLE } from '../prompt/template';
import { mentions, relevantGlossary, type ChunkPromptInputs } from './chunk-input';
import { CHUNK_RESULTS_SCHEMA } from './chunk-output';
import { runChunk } from './chunk-run';

let root: string;
let store: PaperCacheStore;
let document: ExtractionDocument;
let chunk: PlannedChunk;
const NOW = new Date('2026-09-27T11:00:00.000Z');
const GEN = 'gen_test';
const CONTEXT_SHA = 'c'.repeat(64);
const USAGE: Usage = {
  logicalJobs: 1,
  turnCount: 1,
  reportedModelCalls: null,
  inputTokens: 500,
  cachedInputTokens: 0,
  outputTokens: 80,
  reasoningTokens: 5,
  elapsedMs: 40,
};
const context: ContextDocument = {
  ...sampleContext,
  glossary: [
    {
      id: 'g_1',
      term: 'zzz-not-in-paper',
      aliases: [],
      preferredKo: '없음',
      displayRule: '',
      meaningInPaper: '',
      evidenceSentenceIds: [],
      conceptIds: [],
    },
  ],
};

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'paperlens-chunk-'));
  store = new PaperCacheStore(root);
  await store.initPaper(TINY_SHA, NOW);
  const r = await saveTextItems(
    store,
    {
      pdfSha256: TINY_SHA,
      pdfjsVersion: '6.3.289',
      textExtractorVersion: '2',
      pages: tinyPages(),
      textItems: tinyItems(),
      fonts: tinyFonts(),
    },
    { parserConfigHash: 'cfg0', now: NOW },
  );
  await saveOriginalTei(store, TINY_SHA, r.extractionRevision, TINY_TEI);
  const built = await buildAndSaveDocument(store, TINY_SHA, {
    fileName: 'tiny.pdf',
    pages: tinyPages(),
    parserVersion: '0.9.1',
    parserConfigHash: 'cfg0',
    now: NOW,
  });
  document = built.build.document;
  // 대상과 문맥이 모두 있는 청크가 나오도록 아주 작게 나눈다.
  const plan = planChunks(document, { minTokens: 0, maxTokens: 1, neighborSentences: 1 });
  const picked = plan.chunks.find((c) => c.neighborSentenceIds.length > 0) ?? plan.chunks[0];
  if (!picked) throw new Error('청크가 없습니다');
  chunk = picked;
  await store.updateManifest(TINY_SHA, (m) => {
    m.state = 'translating';
  });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const inputsOf = (request: LlmJobRequest): ChunkPromptInputs =>
  JSON.parse(request.prompt.slice(INPUT_PREAMBLE.length + 1)) as ChunkPromptInputs;

const runnerOf = (
  reply: (request: LlmJobRequest) => LlmJobResult,
): LlmJobRunner & { requests: LlmJobRequest[] } => {
  const requests: LlmJobRequest[] = [];
  return {
    requests,
    run: (request) => {
      requests.push(request);
      return Promise.resolve(reply(request));
    },
    cancel: (jobId) => Promise.resolve({ jobId, status: 'not_found' }),
    activeJobIds: () => [],
  };
};

const okWith =
  (make: (inputs: ChunkPromptInputs) => unknown) =>
  (request: LlmJobRequest): LlmJobResult => {
    const value = make(inputsOf(request));
    return {
      ok: true,
      jobId: request.jobId,
      value,
      rawText: JSON.stringify(value),
      model: 'fake-model',
      usage: USAGE,
    };
  };

const translate = (inputs: ChunkPromptInputs): unknown => ({
  kind: 'results',
  results: inputs.TARGET_SENTENCES.map((s) => ({
    id: s.id,
    ko: `  번역: ${s.en}  `,
    note: '',
    warnings: [' '],
  })),
});

const failWith =
  (kind: LlmJobFailureKind) =>
  (request: LlmJobRequest): LlmJobResult => ({
    ok: false,
    jobId: request.jobId,
    kind,
    message: `실패 ${kind}`,
    errors: [],
    rawText: null,
    model: null,
    usage: { ...USAGE, inputTokens: null, outputTokens: null, reasoningTokens: null },
  });

const options = (over: Partial<Parameters<typeof runChunk>[1]> = {}) => ({
  pdfSha256: TINY_SHA,
  generationId: GEN,
  document,
  context,
  contextSha256: CONTEXT_SHA,
  chunk,
  ...over,
});
const deps = (runner: LlmJobRunner) => ({ store, runner, now: () => NOW });

describe('runChunk', () => {
  it('대상 ID를 모두 돌려받으면 완료로 저장하고 manifest에 해시·사용량을 기록한다', async () => {
    const runner = runnerOf(okWith(translate));
    const result = await runChunk(deps(runner), options());
    expect(result).toMatchObject({ ok: true, reused: false, state: 'translating' });
    if (!result.ok) return;
    const saved = await store.readJson('chunkDocument', result.chunkPath);
    expect(saved).toEqual(result.chunk);
    expect(saved).toMatchObject({
      id: chunk.id,
      sectionId: chunk.sectionId,
      sectionIds: chunk.sectionIds,
      targetSentenceIds: chunk.targetSentenceIds,
      neighborSentenceIds: chunk.neighborSentenceIds,
      status: 'complete',
      attempts: 1,
      contextVersion: 1,
      threadId: null,
      turnId: null,
      lastError: null,
    });
    expect(saved.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(saved.resultHash).toMatch(/^[0-9a-f]{64}$/);
    // 캐시에는 원래 ID가 들어가고 글은 다듬어 저장한다.
    expect(saved.results.map((r) => r.id)).toEqual(chunk.targetSentenceIds);
    const first = saved.results[0];
    expect(first?.ko.startsWith('번역: ')).toBe(true);
    expect(first).toMatchObject({ note: '', refs: [], conceptIds: [], warnings: [] });

    const manifest = await store.readManifest(TINY_SHA);
    expect(manifest.usage).toMatchObject({ logicalJobs: 1, inputTokens: 500, outputTokens: 80 });
    expect(manifest.errors).toEqual([]);
    expect(manifest.files.map((f) => f.path)).toContain(
      join('generations', GEN, 'chunks', `${chunk.id}.json`),
    );
    expect(await store.verifyFiles(TINY_SHA)).toEqual([]);
  });

  it('요청은 results만 허용하는 스키마를 쓰고, 문맥 문장에는 id가 없다', async () => {
    const runner = runnerOf(okWith(translate));
    await runChunk(deps(runner), options());
    const request = runner.requests[0];
    expect(request).toMatchObject({
      research: { kind: 'none' },
      outputSchema: CHUNK_RESULTS_SCHEMA,
    });
    expect(CHUNK_RESULTS_SCHEMA.properties.kind.enum).toEqual(['results']);
    if (!request) return;
    const inputs = inputsOf(request);
    expect(inputs.TARGET_SENTENCES.map((s) => s.id).every((id) => /^s\d+$/.test(id))).toBe(true);
    expect(inputs.TARGET_SENTENCES).toHaveLength(chunk.targetSentenceIds.length);
    const neighbors = [
      ...(inputs.NEIGHBOR_CONTEXT?.before ?? []),
      ...(inputs.NEIGHBOR_CONTEXT?.after ?? []),
    ];
    expect(neighbors).toHaveLength(chunk.neighborSentenceIds.length);
    for (const n of neighbors) expect(Object.keys(n)).toEqual(['en']);
    // 이 청크에 나오지 않는 용어는 보내지 않는다.
    expect(inputs.GLOSSARY).toEqual([]);
    expect(inputs.PAPER_CONTEXT.summary).toBe(context.summary);
  });

  it('모델이 순서를 바꿔 돌려줘도 대상 문장 순서로 저장한다', async () => {
    const plan = planChunks(document, { minTokens: 0, maxTokens: 100_000, neighborSentences: 0 });
    const whole = plan.chunks[0];
    if (!whole) throw new Error('청크가 없습니다');
    expect(whole.targetSentenceIds.length).toBeGreaterThan(1);
    const runner = runnerOf(
      okWith((inputs) => {
        const value = translate(inputs) as { kind: string; results: unknown[] };
        return { ...value, results: [...value.results].reverse() };
      }),
    );
    const result = await runChunk(deps(runner), options({ chunk: whole }));
    expect(result.ok).toBe(true);
    expect(result.chunk.results.map((r) => r.id)).toEqual(whole.targetSentenceIds);
  });

  it('누락·중복·대상 아닌 ID가 있으면 완료로 저장하지 않는다', async () => {
    const plan = planChunks(document, { minTokens: 0, maxTokens: 100_000, neighborSentences: 0 });
    const whole = plan.chunks[0];
    if (!whole) throw new Error('청크가 없습니다');
    const runner = runnerOf(
      okWith((inputs) => {
        const value = translate(inputs) as { kind: string; results: { id: string }[] };
        const first = value.results[0];
        if (!first) return value;
        return {
          ...value,
          results: [first, first, { ...first, id: 's9999' }, ...value.results.slice(2)],
        };
      }),
    );
    const result = await runChunk(
      deps(runner),
      options({ chunk: whole, maxRepairs: 0, allowSplit: false }),
    );
    expect(result).toMatchObject({ ok: false, code: 'validation_failed', state: 'translating' });
    if (result.ok) return;
    expect(result.issues.map((i) => [i.code, i.sentenceId])).toEqual([
      ['duplicate_id', whole.targetSentenceIds[0]],
      ['unexpected_id', null],
      ['missing_id', whole.targetSentenceIds[1]],
    ]);
    expect(result.message).toContain(
      '청크 검증 실패: duplicate_id 1, unexpected_id 1, missing_id 1',
    );
    expect(result.rawText).not.toBeNull();
    const saved = await store.readJson('chunkDocument', result.chunkPath);
    expect(saved).toMatchObject({ status: 'failed', resultHash: null });
    // 검증에 걸린 두 문장의 결과는 저장하지 않는다.
    expect(saved.results.map((r) => r.id)).toEqual(whole.targetSentenceIds.slice(2));
    expect(saved.lastError).toMatchObject({
      stage: 'translate',
      code: 'chunk_duplicate_id',
      retryable: true,
      attempt: 1,
    });
    const manifest = await store.readManifest(TINY_SHA);
    expect(manifest.errors).toHaveLength(1);
    expect(manifest.usage).toMatchObject({ logicalJobs: 1, inputTokens: 500 });
  });

  it('완료 청크는 다시 요청하지 않는다. 입력이 바뀌면 다시 요청한다', async () => {
    const runner = runnerOf(okWith(translate));
    const first = await runChunk(deps(runner), options());
    const again = await runChunk(deps(runner), options());
    expect(again).toMatchObject({ ok: true, reused: true, usage: null });
    expect(again.chunk).toEqual(first.chunk);
    expect(runner.requests).toHaveLength(1);
    expect((await store.readManifest(TINY_SHA)).usage.logicalJobs).toBe(1);

    const changed = await runChunk(deps(runner), options({ contextSha256: 'd'.repeat(64) }));
    expect(changed).toMatchObject({ ok: true, reused: false });
    expect(changed.chunk.inputHash).not.toBe(first.chunk.inputHash);
    expect(runner.requests).toHaveLength(2);
  });

  it('실패한 청크는 다시 실행할 수 있고 시도 횟수가 기록된다', async () => {
    const failed = await runChunk(
      deps(runnerOf(failWith('timeout'))),
      options({ allowSplit: false }),
    );
    expect(failed).toMatchObject({ ok: false, code: 'llm_failed', llmKind: 'timeout' });
    expect(failed.chunk).toMatchObject({ status: 'failed', attempts: 1 });
    const retry = await runChunk(
      deps(runnerOf(okWith(translate))),
      options({ previousAttempts: failed.chunk.attempts }),
    );
    expect(retry).toMatchObject({ ok: true, reused: false });
    expect(retry.chunk).toMatchObject({ status: 'complete', attempts: 2, lastError: null });
    expect(retry.chunk.jobId).toBe(`tr_${GEN}_${chunk.id}_2`);
  });

  it('로그인 필요·한도 초과는 논문 상태를 바꾼다', async () => {
    const login = await runChunk(deps(runnerOf(failWith('needs_login'))), options());
    expect(login).toMatchObject({ ok: false, llmKind: 'needs_login', state: 'needs_login' });
    const quota = await runChunk(deps(runnerOf(failWith('quota'))), options());
    expect(quota).toMatchObject({ ok: false, llmKind: 'quota', state: 'waiting_quota' });
  });

  it('스키마와 다른 값을 받으면 output_shape', async () => {
    const runner = runnerOf(okWith(() => ({ kind: 'needsResearch', results: [] })));
    expect(
      await runChunk(deps(runner), options({ maxRepairs: 0, allowSplit: false })),
    ).toMatchObject({
      ok: false,
      code: 'output_shape',
    });
  });
});

describe('용어집 고르기', () => {
  it('낱말 단위로 찾고 대소문자를 가리지 않는다', () => {
    expect(mentions('We use RAG models.', 'rag')).toBe(true);
    expect(mentions('A fragment of text.', 'rag')).toBe(false);
    expect(mentions('Dense Passage Retriever (DPR) is used.', 'DPR')).toBe(true);
    expect(mentions('top-K approximation', 'top-k')).toBe(true);
    expect(mentions('anything', ' ')).toBe(false);
  });

  it('용어나 별칭이 나오는 항목만 고른다', () => {
    const entry = context.glossary[0];
    if (!entry) throw new Error('용어집이 비었습니다');
    const glossary = [
      { ...entry, id: 'g_1', term: 'retrieval-augmented generation', aliases: ['RAG'] },
      { ...entry, id: 'g_2', term: 'beam search', aliases: [] },
    ];
    expect(relevantGlossary(glossary, 'RAG is simple.').map((g) => g.id)).toEqual(['g_1']);
  });
});
