import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaperCacheStore } from '../cache/paper-cache-store';
import type { LlmJobEvent, LlmJobResult } from '../llm/job';
import { InflightStore } from './inflight-store';

const SHA = '7'.repeat(64);
const GEN = 'gen_test';
const NOW = new Date('2026-09-30T00:00:00.000Z');
const USAGE = { logicalJobs: 1, turnCount: 1, elapsedMs: 1 };

let root: string;
let store: PaperCacheStore;
let inflight: InflightStore;
let dir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'paperlens-inflight-'));
  store = new PaperCacheStore(root);
  inflight = new InflightStore(store, SHA, GEN, { now: () => NOW, flushMs: 5 });
  dir = store.inflightDir(SHA, GEN);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const meta = (jobId: string, attempt = 1, unitId = 'chunk_0001') => ({
  jobId,
  stage: 'translate' as const,
  unitId,
  attempt,
  inputHash: 'h1',
  targetIds: ['a', 'b'],
  neighborIds: ['n'],
});
const output = (jobId: string, item: number, delta: string): LlmJobEvent => ({
  type: 'output',
  jobId,
  chars: 0,
  item,
  delta,
});
const failed = (jobId: string, over: Partial<LlmJobResult> = {}): LlmJobResult =>
  ({
    ok: false,
    jobId,
    kind: 'quota',
    message: '한도',
    errors: [],
    rawText: null,
    model: null,
    usage: USAGE,
    ...over,
  }) as LlmJobResult;
const read = (name: string): Promise<string> => fs.readFile(join(dir, name), 'utf8');

describe('InflightStore', () => {
  it('작업이 끝나지 않아도 받은 데까지의 글이 파일에 남는다', async () => {
    const recorder = await inflight.begin(meta('job_1'));
    if (!recorder) throw new Error('기록을 시작하지 못함');
    recorder.onEvent(output('job_1', 1, '{"results":[{"id":'));
    recorder.onEvent(output('job_1', 1, '"s1"}'));
    recorder.onEvent(output('other_job', 1, '다른 작업'));
    await recorder.flush();
    // finish를 부르지 않았다. 강제 종료된 경우와 같다.
    expect(await read('job_1.txt')).toBe('{"results":[{"id":"s1"}');
    expect(await inflight.list('translate', 'chunk_0001')).toMatchObject([
      {
        meta: { jobId: 'job_1', attempt: 1, inputHash: 'h1', endedAt: null, outcome: null },
        text: '{"results":[{"id":"s1"}',
        trace: null,
      },
    ]);
  });

  it('정해진 간격으로 스스로 파일에 넘긴다', async () => {
    const recorder = await inflight.begin(meta('job_1'));
    recorder?.onEvent(output('job_1', 1, '조각'));
    const end = Date.now() + 2_000;
    while ((await read('job_1.txt')) === '' && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await read('job_1.txt')).toBe('조각');
    await recorder?.finish(failed('job_1', { partialText: '조각' }));
  });

  it('새 메시지가 시작되면 앞 메시지의 글을 지운다', async () => {
    const recorder = await inflight.begin(meta('job_1'));
    recorder?.onEvent(output('job_1', 1, 'Working on it.'));
    await recorder?.flush();
    recorder?.onEvent(output('job_1', 2, '{"results":['));
    await recorder?.flush();
    recorder?.onEvent(output('job_1', 2, '{"id":"s1"}'));
    await recorder?.flush();
    expect(await read('job_1.txt')).toBe('{"results":[{"id":"s1"}');
  });

  it('작업이 실패로 끝나면 끝난 때의 글과 검색 기록을 남긴다', async () => {
    const recorder = await inflight.begin({ ...meta('job_1'), stage: 'concept_research' });
    recorder?.onEvent(output('job_1', 1, '{"concepts":[{"id'));
    const trace = {
      queries: ['q'],
      openRequests: [],
      results: [{ url: 'https://read.example/a', title: 't', domain: null, viewed: true }],
      searchItems: 1,
      failedViews: 0,
    };
    await recorder?.finish(
      failed('job_1', { partialText: '{"concepts":[{"id":"c_1"', research: trace }),
    );
    expect(await inflight.list('concept_research')).toMatchObject([
      {
        meta: { outcome: 'quota', endedAt: NOW.toISOString() },
        text: '{"concepts":[{"id":"c_1"',
        trace,
      },
    ]);
    // 끝난 뒤에 온 조각은 받지 않는다.
    recorder?.onEvent(output('job_1', 1, '늦은 조각'));
    await recorder?.flush();
    expect(await read('job_1.txt')).toBe('{"concepts":[{"id":"c_1"');
  });

  it('끝나지 못한 메시지가 없으면 끝난 메시지의 글을 남긴다', async () => {
    const a = await inflight.begin(meta('job_1'));
    await a?.finish(failed('job_1', { kind: 'invalid_json', rawText: 'Sure!' }));
    const b = await inflight.begin(meta('job_2', 2));
    await b?.finish({
      ok: true,
      jobId: 'job_2',
      value: {},
      rawText: '{"results":[]}',
      model: null,
      usage: USAGE,
    });
    const c = await inflight.begin(meta('job_3', 3));
    await c?.finish(failed('job_3'));
    expect((await inflight.list('translate')).map((e) => [e.meta.outcome, e.text])).toEqual([
      ['invalid_json', 'Sure!'],
      ['ok', '{"results":[]}'],
      ['quota', ''],
    ]);
  });

  it('단계와 단위로 고르고 요청 순서로 돌려준다. 지운 기록은 나오지 않는다', async () => {
    for (const [jobId, attempt, unit] of [
      ['job_b', 2, 'chunk_0001'],
      ['job_a', 10, 'chunk_0001'],
      ['job_c', 1, 'chunk_0002'],
    ] as const) {
      const r = await inflight.begin(meta(jobId, attempt, unit));
      await r?.finish(failed(jobId));
    }
    expect((await inflight.list('translate', 'chunk_0001')).map((e) => e.meta.jobId)).toEqual([
      'job_b',
      'job_a',
    ]);
    expect(await inflight.list('context')).toEqual([]);
    await inflight.remove(['job_b', 'job_c', '../밖']);
    expect((await inflight.list('translate')).map((e) => e.meta.jobId)).toEqual(['job_a']);
    expect((await fs.readdir(dir)).sort()).toEqual(['job_a.meta.json', 'job_a.txt']);
  });

  it('읽지 못하는 기록은 건너뛰고, 파일 이름으로 쓸 수 없는 작업 id는 받지 않는다', async () => {
    const r = await inflight.begin(meta('job_1'));
    await r?.finish(failed('job_1'));
    await fs.writeFile(join(dir, 'broken.meta.json'), '{');
    await fs.writeFile(join(dir, 'other.meta.json'), JSON.stringify({ jobId: 'other' }));
    expect((await inflight.list('translate')).map((e) => e.meta.jobId)).toEqual(['job_1']);
    expect(await inflight.begin(meta('../job'))).toBeNull();
    expect(await new InflightStore(store, SHA, 'gen_none').list('translate')).toEqual([]);
  });

  it('manifest와 완료 결과의 자리를 건드리지 않는다', async () => {
    await store.initPaper(SHA, NOW);
    const before = await store.readManifest(SHA);
    const r = await inflight.begin(meta('job_1'));
    await r?.finish(failed('job_1', { partialText: '글' }));
    expect(await store.readManifest(SHA)).toEqual(before);
    expect(await fs.readdir(join(store.paperDir(SHA), 'generations', GEN))).toEqual(['inflight']);
  });
});
