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
import { InflightStore } from '../resume/inflight-store';
import type { ChunkPromptInputs } from './chunk-input';
import { PREVIOUS_OUTPUT_LIMIT, runChunk } from './chunk-run';

/** 돌던 작업의 보존과 이어 하기(COMMIT_PLAN M3 P2). */
const SHA = 'd'.repeat(64);
const GEN = 'gen_resume';
const NOW = new Date('2026-09-30T01:00:00.000Z');
const CONTEXT_SHA = 'c'.repeat(64);
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
  root = await fs.mkdtemp(join(tmpdir(), 'paperlens-resume-'));
  store = new PaperCacheStore(root);
  await store.initPaper(SHA, NOW);
  await store.updateManifest(SHA, (m) => {
    m.state = 'translating';
  });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

type Inputs = ChunkPromptInputs & { PREVIOUS_OUTPUT?: string };
const inputsOf = (request: LlmJobRequest): Inputs =>
  JSON.parse(request.prompt.slice(INPUT_PREAMBLE.length + 1)) as Inputs;
const targetsOf = (request: LlmJobRequest): string[] =>
  inputsOf(request).TARGET_SENTENCES.map((s) => s.id);

const item = (alias: string, ko: string): Record<string, unknown> => ({
  id: alias,
  ko,
  explain: `해설 ${alias}`,
  example: '',
  caution: '',
  conceptIds: [],
  warnings: [],
});
/** 모델이 쓰다가 끊긴 출력. 앞의 문장들은 끝까지 쓰였고 마지막 문장은 도중에 끊겼다. */
const cutOutput = (
  written: Record<string, unknown>[],
  cut = '{"id":"s4","ko":"세 번째 대',
): string =>
  `{"kind":"results","results":[${written.map((w) => JSON.stringify(w)).join(',')},${cut}`;
const S2 = item('s2', '앞선 번역 [EQ_1]');
const S3 = item('s3', '앞선 번역 둘');

type Reply =
  | { fail: LlmJobFailureKind; partial?: string }
  | { make: (inputs: Inputs) => Record<string, unknown>[] };
const fresh = (inputs: Inputs): Record<string, unknown>[] =>
  inputs.TARGET_SENTENCES.map((s) =>
    item(s.id, `새 번역 ${s.id}${s.en.includes('[EQ_1]') ? ' [EQ_1]' : ''}`),
  );

/** 요청 순서대로 응답한다. 실패 응답에 partial이 있으면 그 글을 조각으로 보낸 뒤에 실패한다. */
const scripted = (replies: Reply[]): LlmJobRunner & { requests: LlmJobRequest[] } => {
  const requests: LlmJobRequest[] = [];
  return {
    requests,
    run: (request, onEvent) => {
      const reply = replies[Math.min(requests.length, replies.length - 1)];
      requests.push(request);
      if (!reply) throw new Error('응답이 없습니다');
      if ('fail' in reply) {
        const partial = reply.partial ?? null;
        if (partial !== null) {
          onEvent?.({
            type: 'output',
            jobId: request.jobId,
            chars: 14,
            item: 1,
            delta: 'Working on it.',
          });
          for (let at = 0; at < partial.length; at += 7) {
            const delta = partial.slice(at, at + 7);
            onEvent?.({ type: 'output', jobId: request.jobId, chars: at, item: 2, delta });
          }
        }
        const result: LlmJobResult = {
          ok: false,
          jobId: request.jobId,
          kind: reply.fail,
          message: `실패 ${reply.fail}`,
          errors: [],
          rawText: partial === null ? null : 'Working on it.',
          partialText: partial,
          model: null,
          usage: USAGE,
        };
        return Promise.resolve(result);
      }
      const value = { kind: 'results', results: reply.make(inputsOf(request)) };
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

const run = (
  runner: LlmJobRunner,
  over: Partial<Parameters<typeof runChunk>[1]> = {},
): ReturnType<typeof runChunk> =>
  runChunk(
    { store, runner, now: () => NOW },
    {
      pdfSha256: SHA,
      generationId: GEN,
      document,
      context: sampleContext,
      contextSha256: CONTEXT_SHA,
      chunk,
      ...over,
    },
  );
const inflightFiles = async (): Promise<string[]> => {
  try {
    return (await fs.readdir(store.inflightDir(SHA, GEN))).sort();
  } catch {
    return [];
  }
};
const inflightText = (jobId: string): Promise<string> =>
  fs.readFile(join(store.inflightDir(SHA, GEN), `${jobId}.txt`), 'utf8');
const kinds = (result: Awaited<ReturnType<typeof runChunk>>): string[] =>
  result.attempts.map((a) => `${a.kind}:${a.outcome}:${a.targetCount}:${a.accepted}`);

describe('runChunk 이어 하기', () => {
  it('출력 도중 한도에 걸린 청크는 받은 글이 남고, 다시 실행하면 남은 문장만 요청한다', async () => {
    const cut = cutOutput([S2, S3]);
    const stopped = await run(scripted([{ fail: 'quota', partial: cut }]));
    expect(stopped).toMatchObject({ ok: false, llmKind: 'quota', state: 'waiting_quota' });
    expect(stopped.chunk).toMatchObject({ status: 'failed', attempts: 1, results: [] });
    expect(await inflightFiles()).toEqual([
      `tr_${GEN}_chunk_0001_1.meta.json`,
      `tr_${GEN}_chunk_0001_1.txt`,
    ]);
    expect(await inflightText(`tr_${GEN}_chunk_0001_1`)).toBe(cut);

    const runner = scripted([{ make: fresh }]);
    const resumed = await run(runner);
    expect(resumed).toMatchObject({ ok: true, reused: false, recovered: 2 });
    expect(kinds(resumed)).toEqual(['resume:ok:2:2']);
    // 끝까지 쓰인 두 문장은 다시 요청하지 않는다. 쓰다가 끊긴 문장은 다시 요청한다.
    expect(runner.requests.map(targetsOf)).toEqual([['s4', 's5']]);
    expect(runner.requests[0]?.jobId).toBe(`tr_${GEN}_chunk_0001_2`);
    expect(runner.requests[0]?.instructions).toContain('끊긴 작업을 이어서');
    expect(inputsOf(runner.requests[0] as LlmJobRequest).PREVIOUS_OUTPUT).toBe(cut);
    expect(resumed.chunk).toMatchObject({ status: 'complete', attempts: 2, lastError: null });
    expect(resumed.chunk.results.map((r) => [r.id, r.ko, r.explanation?.main])).toEqual([
      ['id_1', '앞선 번역 [EQ_1]', '해설 s2'],
      ['id_2', '앞선 번역 둘', '해설 s3'],
      ['id_3', '새 번역 s4', '해설 s4'],
      ['id_4', '새 번역 s5', '해설 s5'],
    ]);
    // 완료되면 남은 기록을 지운다.
    expect(await inflightFiles()).toEqual([]);
    expect(await store.verifyFiles(SHA)).toEqual([]);
    expect((await store.readManifest(SHA)).usage.logicalJobs).toBe(2);
  });

  it('요청이 끝나지 못하고 앱이 종료돼도 파일에 넘긴 데까지 건진다', async () => {
    // 첫 실행이 강제 종료된 경우: 청크 파일은 없고 받던 글만 있다.
    const hash = (await run(scripted([{ fail: 'timeout' }]), { allowSplit: false })).chunk
      .inputHash;
    await fs.rm(join(store.paperDir(SHA), 'generations', GEN), { recursive: true, force: true });
    await store.updateManifest(SHA, (m) => {
      m.files = [];
      m.errors = [];
    });
    const killed = await new InflightStore(store, SHA, GEN, { now: () => NOW }).begin({
      jobId: `tr_${GEN}_chunk_0001_1`,
      stage: 'translate',
      unitId: 'chunk_0001',
      attempt: 1,
      inputHash: hash,
      targetIds: chunk.targetSentenceIds,
      neighborIds: chunk.neighborSentenceIds,
    });
    const cut = cutOutput([S2]);
    killed?.onEvent({
      type: 'output',
      jobId: `tr_${GEN}_chunk_0001_1`,
      chars: 0,
      item: 1,
      delta: cut,
    });
    await killed?.flush();

    // 이어 하던 요청도 출력 없이 끊긴다. 건진 문장은 요청 전에 저장했으므로 남는다.
    const again = await run(scripted([{ fail: 'quota' }]));
    expect(again).toMatchObject({ ok: false, llmKind: 'quota', recovered: 1 });
    expect(kinds(again)).toEqual(['resume:llm_failed:3:0']);
    expect(again.chunk).toMatchObject({ status: 'failed', attempts: 2 });
    expect(again.chunk.results.map((r) => r.id)).toEqual(['id_1']);

    const runner = scripted([{ make: fresh }]);
    const done = await run(runner);
    expect(done).toMatchObject({ ok: true, recovered: 1 });
    expect(runner.requests.map(targetsOf)).toEqual([['s3', 's4', 's5']]);
    expect(runner.requests[0]?.jobId).toBe(`tr_${GEN}_chunk_0001_3`);
    expect(done.chunk.results.map((r) => r.ko)).toEqual([
      '앞선 번역 [EQ_1]',
      '새 번역 s3',
      '새 번역 s4',
      '새 번역 s5',
    ]);
    expect(await inflightFiles()).toEqual([]);
  });

  it('건진 문장도 검증기를 거친다. 걸린 문장과 모양이 다른 항목은 받지 않는다', async () => {
    const cut = cutOutput([
      // 자리표시자가 빠졌다.
      item('s2', '자리표시자 없는 번역'),
      S3,
      // 필수 칸이 없다.
      { id: 's4', ko: '칸이 모자란 항목' },
      // 대상이 아닌 문장이다.
      item('s1', '문맥 문장의 번역'),
      item('s9', '없는 문장의 번역'),
    ]);
    await run(scripted([{ fail: 'timeout', partial: cut }]), { allowSplit: false });
    const runner = scripted([{ make: fresh }]);
    const resumed = await run(runner);
    expect(resumed).toMatchObject({ ok: true, recovered: 1 });
    expect(runner.requests.map(targetsOf)).toEqual([['s2', 's4', 's5']]);
    expect(resumed.chunk.results.map((r) => r.ko)).toEqual([
      '새 번역 s2 [EQ_1]',
      '앞선 번역 둘',
      '새 번역 s4',
      '새 번역 s5',
    ]);
  });

  it('모든 문장이 끝까지 쓰인 뒤에 끊겼으면 요청 없이 완료로 저장한다', async () => {
    const all = cutOutput(
      [S2, S3, item('s4', '앞선 번역 셋'), item('s5', '앞선 번역 넷')],
      '',
    ).slice(0, -1);
    await run(scripted([{ fail: 'timeout', partial: all }]), { allowSplit: false });
    const runner = scripted([{ make: fresh }]);
    const resumed = await run(runner);
    expect(runner.requests).toEqual([]);
    expect(resumed).toMatchObject({ ok: true, reused: false, recovered: 4, usage: null });
    expect(resumed.chunk).toMatchObject({ status: 'complete', attempts: 1 });
    expect(resumed.chunk.results.map((r) => r.ko)).toEqual([
      '앞선 번역 [EQ_1]',
      '앞선 번역 둘',
      '앞선 번역 셋',
      '앞선 번역 넷',
    ]);
    expect(await inflightFiles()).toEqual([]);
    expect(await store.verifyFiles(SHA)).toEqual([]);
  });

  it('입력이 달라졌으면 남은 출력을 쓰지 않고 지운다', async () => {
    await run(scripted([{ fail: 'quota', partial: cutOutput([S2, S3]) }]));
    const runner = scripted([{ make: fresh }]);
    const changed = await run(runner, { contextSha256: 'd'.repeat(64) });
    expect(changed).toMatchObject({ ok: true, recovered: 0 });
    expect(kinds(changed)).toEqual(['initial:ok:4:4']);
    expect(runner.requests.map(targetsOf)).toEqual([['s2', 's3', 's4', 's5']]);
    expect(inputsOf(runner.requests[0] as LlmJobRequest).PREVIOUS_OUTPUT).toBeUndefined();
    expect(changed.chunk.results.map((r) => r.ko)[0]).toBe('새 번역 s2 [EQ_1]');
    expect(await inflightFiles()).toEqual([]);
  });

  it('검증에 걸려 실패한 청크를 다시 실행하면 통과했던 문장은 다시 요청하지 않는다', async () => {
    const broken = (inputs: Inputs): Record<string, unknown>[] =>
      inputs.TARGET_SENTENCES.map((s) =>
        s.en.includes('[EQ_1]') ? item(s.id, '자리표시자 없음') : item(s.id, `첫 번역 ${s.id}`),
      );
    const failed = await run(scripted([{ make: broken }]), { maxRepairs: 0, allowSplit: false });
    expect(failed).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(failed.chunk.results.map((r) => r.id)).toEqual(['id_2', 'id_3', 'id_4']);

    const runner = scripted([{ make: fresh }]);
    const resumed = await run(runner);
    expect(resumed).toMatchObject({ ok: true, recovered: 3 });
    expect(runner.requests.map(targetsOf)).toEqual([['s2']]);
    expect(resumed.chunk.results.map((r) => r.ko)).toEqual([
      '새 번역 s2 [EQ_1]',
      '첫 번역 s3',
      '첫 번역 s4',
      '첫 번역 s5',
    ]);
  });

  it('앞선 출력이 길면 뒷부분만 준다', async () => {
    const long = cutOutput([S2, item('s3', `긴 번역 ${'가'.repeat(PREVIOUS_OUTPUT_LIMIT)}`)]);
    await run(scripted([{ fail: 'quota', partial: long }]));
    const runner = scripted([{ make: fresh }]);
    await run(runner);
    const previous = inputsOf(runner.requests[0] as LlmJobRequest).PREVIOUS_OUTPUT ?? '';
    expect(previous).toHaveLength(PREVIOUS_OUTPUT_LIMIT);
    expect(long.endsWith(previous)).toBe(true);
  });

  it('manifest에 기록이 없는 청크 파일의 결과는 쓰지 않는다', async () => {
    const failed = await run(scripted([{ make: () => [S3] }]), {
      maxRepairs: 0,
      allowSplit: false,
    });
    expect(failed.chunk.results.map((r) => r.id)).toEqual(['id_2']);
    await fs.rm(store.inflightDir(SHA, GEN), { recursive: true, force: true });
    await store.updateManifest(SHA, (m) => {
      m.files = m.files.filter((f) => !f.path.includes('chunks/'));
    });
    const runner = scripted([{ make: fresh }]);
    const again = await run(runner, { previousAttempts: 1 });
    expect(again).toMatchObject({ ok: true, recovered: 0 });
    expect(runner.requests.map(targetsOf)).toEqual([['s2', 's3', 's4', 's5']]);
  });
});
