import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExtractionDocument, Sentence, Usage } from '@shared/schema';
import { sampleContext, sampleExtraction } from '@shared/schema/fixtures';
import { PaperCacheStore } from '../cache/paper-cache-store';
import type { PlannedChunk } from '../chunk/chunker';
import type { LlmJobFailureKind, LlmJobRequest, LlmJobResult, LlmJobRunner } from '../llm/job';
import { INPUT_PREAMBLE } from '../prompt/template';
import type { ChunkPromptInputs } from './chunk-input';
import { neighborsOf, runChunk } from './chunk-run';

const SHA = 'e'.repeat(64);
const GEN = 'gen_retry';
const NOW = new Date('2026-09-27T12:00:00.000Z');
const USAGE: Usage = {
  logicalJobs: 1,
  turnCount: 1,
  reportedModelCalls: null,
  inputTokens: 100,
  cachedInputTokens: 0,
  outputTokens: 10,
  reasoningTokens: 0,
  elapsedMs: 5,
};

const sentence = (n: number, en: string): Sentence => ({
  id: `id_${n}`,
  order: n,
  page: 0,
  pages: [0],
  sectionId: 'sec_a',
  paragraphId: 'p_1',
  kind: 'sentence',
  enRaw: en,
  en,
  sourceSpans: [],
  rects: [],
  mappingStatus: 'mapped',
  equations: [],
  citationMarkers: [],
  warnings: [],
});

// id_0과 id_5는 문맥, id_1~id_4가 대상이다. 별칭은 읽기 순서라 s1~s6이다.
const SENTENCES = [
  sentence(0, 'Earlier work exists.'),
  sentence(1, 'We define [EQ_1] first.'),
  sentence(2, 'The second target is plain.'),
  sentence(3, 'The third target is plain.'),
  sentence(4, 'The fourth target is plain.'),
  sentence(5, 'Later work follows.'),
];
const document: ExtractionDocument = {
  ...sampleExtraction,
  sections: [{ id: 'sec_a', title: 'Method', order: 0, sentenceIds: SENTENCES.map((s) => s.id) }],
  sentences: SENTENCES,
};
const chunk: PlannedChunk = {
  id: 'chunk_0001',
  order: 0,
  sectionId: 'sec_a',
  sectionIds: ['sec_a'],
  targetSentenceIds: ['id_1', 'id_2', 'id_3', 'id_4'],
  neighborSentenceIds: ['id_0', 'id_5'],
  estimatedTokens: 30,
  warnings: [],
};

let root: string;
let store: PaperCacheStore;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'paperlens-retry-'));
  store = new PaperCacheStore(root);
  await store.initPaper(SHA, NOW);
  await store.updateManifest(SHA, (m) => {
    m.state = 'translating';
  });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

type Inputs = ChunkPromptInputs & {
  PROBLEMS?: { id: string | null; code: string; detail: string }[];
  PREVIOUS_OUTPUT?: string;
};
const inputsOf = (request: LlmJobRequest): Inputs =>
  JSON.parse(request.prompt.slice(INPUT_PREAMBLE.length + 1)) as Inputs;

type Reply =
  | { fail: LlmJobFailureKind; rawText?: string }
  | { make: (inputs: Inputs) => { id: string; ko: string }[] };

const good = (inputs: Inputs, tag = 'ko'): { id: string; ko: string }[] =>
  inputs.TARGET_SENTENCES.map((s) => ({
    id: s.id,
    ko: `${tag}:${s.id}${s.en.includes('[EQ_1]') ? ' [EQ_1]' : ''}`,
  }));

/** 요청 순서대로 정해진 응답을 돌려준다. 응답이 모자라면 마지막 응답을 되풀이한다. */
const scripted = (
  replies: Reply[],
): LlmJobRunner & { requests: LlmJobRequest[]; inputs: () => Inputs[] } => {
  const requests: LlmJobRequest[] = [];
  return {
    requests,
    inputs: () => requests.map(inputsOf),
    run: (request) => {
      const reply = replies[Math.min(requests.length, replies.length - 1)];
      requests.push(request);
      if (!reply) throw new Error('응답이 없습니다');
      if ('fail' in reply) {
        const result: LlmJobResult = {
          ok: false,
          jobId: request.jobId,
          kind: reply.fail,
          message: `실패 ${reply.fail}`,
          errors: [],
          rawText: reply.rawText ?? null,
          model: null,
          usage: USAGE,
        };
        return Promise.resolve(result);
      }
      const value = {
        kind: 'results',
        results: reply.make(inputsOf(request)).map((r) => ({
          id: r.id,
          ko: r.ko,
          plain: '',
          role: '',
          example: '',
          deeper: '',
          conceptIds: [],
          warnings: [],
        })),
      };
      return Promise.resolve({
        ok: true,
        jobId: request.jobId,
        value,
        rawText: JSON.stringify(value),
        model: 'fake-model',
        usage: USAGE,
      });
    },
    cancel: (jobId) => Promise.resolve({ jobId, status: 'not_found' }),
    activeJobIds: () => [],
  };
};

const run = (runner: LlmJobRunner): ReturnType<typeof runChunk> =>
  runChunk(
    { store, runner, now: () => NOW },
    {
      pdfSha256: SHA,
      generationId: GEN,
      document,
      context: sampleContext,
      contextSha256: 'c'.repeat(64),
      chunk,
    },
  );
const kinds = (result: Awaited<ReturnType<typeof runChunk>>): string[] =>
  result.attempts.map((a) => `${a.kind}:${a.outcome}:${a.targetCount}:${a.accepted}`);
const targetsOf = (inputs: Inputs): string[] => inputs.TARGET_SENTENCES.map((s) => s.id);
const diagnostics = async (): Promise<string[]> => {
  try {
    return (await fs.readdir(join(store.paperDir(SHA), 'generations', GEN, 'diagnostics'))).sort();
  } catch {
    return [];
  }
};

describe('runChunk 재시도', () => {
  it('JSON이 깨진 응답은 도구 없는 수정 턴 1회로 고치고 원래 출력을 보존한다', async () => {
    const runner = scripted([
      { fail: 'invalid_json', rawText: 'Sure! {"kind": "results", ' },
      { make: good },
    ]);
    const result = await run(runner);
    expect(result).toMatchObject({ ok: true, reused: false });
    expect(kinds(result)).toEqual(['initial:llm_failed:4:0', 'repair:ok:4:4']);
    expect(result.chunk).toMatchObject({ status: 'complete', attempts: 2, lastError: null });
    expect(result.chunk.results.map((r) => r.id)).toEqual(chunk.targetSentenceIds);

    const repair = runner.requests[1];
    expect(repair?.research).toEqual({ kind: 'none' });
    expect(repair?.instructions).toContain('이번 작업은 앞선 결과의 수정이다');
    expect(runner.requests[0]?.instructions).not.toContain('이번 작업은 앞선 결과의 수정이다');
    expect(runner.inputs()[1]?.PREVIOUS_OUTPUT).toBe('Sure! {"kind": "results", ');

    expect(await diagnostics()).toEqual(['chunk_0001.1.json']);
    const saved = JSON.parse(
      await fs.readFile(store.diagnosticsPath(SHA, GEN, 'chunk_0001.1.json'), 'utf8'),
    ) as { rawText: string; llmKind: string; attempt: number };
    expect(saved).toMatchObject({
      rawText: 'Sure! {"kind": "results", ',
      llmKind: 'invalid_json',
      attempt: 1,
    });
    // 두 요청 모두 한도를 썼다.
    expect((await store.readManifest(SHA)).usage).toMatchObject({
      logicalJobs: 2,
      inputTokens: 200,
    });
    expect((await store.readManifest(SHA)).errors).toEqual([]);
  });

  it('검증에 걸린 문장만 다시 보내고 통과한 문장의 결과는 그대로 둔다', async () => {
    const runner = scripted([
      // s2(id_1)의 자리표시자를 지우고 s4(id_3)를 빠뜨린다.
      {
        make: (inputs) =>
          good(inputs, 'first')
            .filter((r) => r.id !== 's4')
            .map((r) => (r.id === 's2' ? { ...r, ko: 'first:s2' } : r)),
      },
      { make: (inputs) => good(inputs, 'repair') },
    ]);
    const result = await run(runner);
    expect(result.ok).toBe(true);
    expect(kinds(result)).toEqual(['initial:validation_failed:4:2', 'repair:ok:2:2']);
    const second = runner.inputs()[1];
    expect(second ? targetsOf(second) : []).toEqual(['s2', 's4']);
    expect(second?.PROBLEMS).toEqual([
      { id: 's2', code: 'placeholder_lost', detail: '[EQ_1] 원문 1개, 번역 0개' },
      { id: 's4', code: 'missing_id', detail: '결과가 없습니다' },
    ]);
    expect(result.chunk.results.map((r) => [r.id, r.ko])).toEqual([
      ['id_1', 'repair:s2 [EQ_1]'],
      ['id_2', 'first:s3'],
      ['id_3', 'repair:s4'],
      ['id_4', 'first:s5'],
    ]);
  });

  it('수정 턴이 이미 통과한 문장을 돌려줘도 덮어쓰지 않는다', async () => {
    const runner = scripted([
      { make: (inputs) => good(inputs, 'first').filter((r) => r.id !== 's4') },
      {
        make: (inputs) => [...good(inputs, 'repair'), { id: 's3', ko: 'repair:s3' }],
      },
      { make: (inputs) => good(inputs, 'split') },
    ]);
    const result = await run(runner);
    expect(result.ok).toBe(true);
    // 수정 턴은 대상이 아닌 id(s3)를 돌려줘 실패로 치지만, 맞게 온 s4의 결과는 받는다.
    expect(kinds(result)).toEqual([
      'initial:validation_failed:4:3',
      'repair:validation_failed:1:1',
    ]);
    expect(result.chunk.results.map((r) => [r.id, r.ko])).toEqual([
      ['id_1', 'first:s2 [EQ_1]'],
      ['id_2', 'first:s3'],
      ['id_3', 'repair:s4'],
      ['id_4', 'first:s5'],
    ]);
  });

  it('수정해도 실패하면 청크를 반으로 나눠 한 번씩 요청한다', async () => {
    const bad: Reply = { make: () => [] };
    const runner = scripted([
      bad,
      bad,
      { make: (i) => good(i, 'a') },
      { make: (i) => good(i, 'b') },
    ]);
    const result = await run(runner);
    expect(result.ok).toBe(true);
    expect(kinds(result)).toEqual([
      'initial:validation_failed:4:0',
      'repair:validation_failed:4:0',
      'split:ok:2:2',
      'split:ok:2:2',
    ]);
    const inputs = runner.inputs();
    expect(inputs.slice(2).map(targetsOf)).toEqual([
      ['s2', 's3'],
      ['s4', 's5'],
    ]);
    // 나눈 조각의 문맥은 그 조각 바로 앞뒤 문장이다. 다른 조각의 대상이 문맥으로 들어간다.
    expect(inputs[2]?.NEIGHBOR_CONTEXT).toEqual({
      before: [{ en: 'Earlier work exists.' }],
      after: [{ en: 'The third target is plain.' }],
    });
    // 나눈 요청은 수정 턴이 아니라 보통 청크 요청이다.
    expect(inputs[2]?.PROBLEMS).toBeUndefined();
    expect(result.chunk.attempts).toBe(4);
    expect(result.chunk.results.map((r) => r.ko)).toEqual(['a:s2 [EQ_1]', 'a:s3', 'b:s4', 'b:s5']);
    expect(await diagnostics()).toEqual(['chunk_0001.1.json', 'chunk_0001.2.json']);
  });

  it('끝까지 실패하면 실패로 표시하고 통과한 문장의 결과만 남긴다', async () => {
    // 첫 요청과 수정은 아무것도 못 주고, 나눈 첫 조각만 성공한다.
    const bad: Reply = { make: () => [] };
    const runner = scripted([bad, bad, { make: (i) => good(i, 'a') }, bad]);
    const result = await run(runner);
    expect(result).toMatchObject({ ok: false, code: 'validation_failed', state: 'translating' });
    expect(runner.requests).toHaveLength(4);
    expect(result.chunk).toMatchObject({ status: 'failed', attempts: 4, resultHash: null });
    expect(result.chunk.completedAt).toBeNull();
    expect(result.chunk.results.map((r) => r.id)).toEqual(['id_1', 'id_2']);
    expect(result.chunk.lastError).toMatchObject({
      stage: 'translate',
      code: 'chunk_missing_id',
      retryable: true,
      attempt: 4,
    });
    expect(result.chunk.lastError?.message).toContain('요청 4회, 문장 4개 중 2개 미완료');
    const manifest = await store.readManifest(SHA);
    expect(manifest.errors).toHaveLength(1);
    expect(manifest.usage.logicalJobs).toBe(4);
    expect(await store.verifyFiles(SHA)).toEqual([]);
  });

  it('출력이 없거나 시간이 넘은 요청은 수정 없이 바로 나눈다', async () => {
    const runner = scripted([{ fail: 'timeout' }, { make: (i) => good(i) }]);
    const result = await run(runner);
    expect(result.ok).toBe(true);
    expect(kinds(result)).toEqual(['initial:llm_failed:4:0', 'split:ok:2:2', 'split:ok:2:2']);
  });

  it('로그인·한도 문제는 다시 요청하지 않고 멈춘다', async () => {
    const login = scripted([{ fail: 'needs_login' }, { make: (i) => good(i) }]);
    const result = await run(login);
    expect(result).toMatchObject({ ok: false, llmKind: 'needs_login', state: 'needs_login' });
    expect(login.requests).toHaveLength(1);

    // 나누어 요청하던 중에 한도에 걸리면 남은 조각을 보내지 않는다.
    await store.updateManifest(SHA, (m) => {
      m.state = 'translating';
    });
    const quota = scripted([{ fail: 'timeout' }, { make: (i) => good(i) }, { fail: 'quota' }]);
    const partial = await run(quota);
    expect(partial).toMatchObject({ ok: false, llmKind: 'quota', state: 'waiting_quota' });
    expect(kinds(partial)).toEqual([
      'initial:llm_failed:4:0',
      'split:ok:2:2',
      'split:llm_failed:2:0',
    ]);
    expect(partial.chunk.results.map((r) => r.id)).toEqual(['id_1', 'id_2']);
    expect(partial.chunk.lastError).toMatchObject({ code: 'llm_quota', retryable: true });
  });

  it('대상이 하나만 남으면 나누지 않고 그 문장만 한 번 더 요청한다', async () => {
    const runner = scripted([
      { make: (i) => good(i).filter((r) => r.id !== 's5') },
      { make: () => [] },
      { make: (i) => good(i, 'last') },
    ]);
    const result = await run(runner);
    expect(result.ok).toBe(true);
    expect(kinds(result)).toEqual([
      'initial:validation_failed:4:3',
      'repair:validation_failed:1:0',
      'split:ok:1:1',
    ]);
  });
});

describe('neighborsOf', () => {
  it('대상 범위 바로 앞뒤 문장을 읽기 순서로 돌려준다', () => {
    expect(neighborsOf(SENTENCES, ['id_2', 'id_3'], 1)).toEqual(['id_1', 'id_4']);
    expect(neighborsOf(SENTENCES, ['id_0'], 2)).toEqual(['id_1', 'id_2']);
    expect(neighborsOf(SENTENCES, ['id_5'], 2)).toEqual(['id_3', 'id_4']);
    expect(neighborsOf(SENTENCES, ['id_2'], 0)).toEqual([]);
    expect(neighborsOf(SENTENCES, ['nope'], 1)).toEqual([]);
  });

  it('떨어진 대상 사이에 낀 문장은 문맥에 넣지 않는다', () => {
    expect(neighborsOf(SENTENCES, ['id_1', 'id_4'], 1)).toEqual(['id_0', 'id_5']);
  });
});
