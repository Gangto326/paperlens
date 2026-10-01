import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Concept, ContextDocument, Usage } from '@shared/schema';
import { sampleChunk, sampleContext } from '@shared/schema/fixtures';
import { PaperCacheStore } from '../cache/paper-cache-store';
import type { LlmJobFailureKind, LlmJobRequest, LlmJobResult, LlmJobRunner } from '../llm/job';
import { INPUT_PREAMBLE } from '../prompt/template';
import {
  CONCEPT_CARDS_OUTPUT_SCHEMA,
  runConceptCards,
  type ConceptCardsModelOutput,
} from './concept-cards';

const SHA = '6'.repeat(64);
const GEN = 'gen_test';
const NOW = new Date('2026-10-01T00:00:00.000Z');
const USAGE: Usage = {
  logicalJobs: 1,
  turnCount: 1,
  reportedModelCalls: null,
  inputTokens: 1000,
  cachedInputTokens: 0,
  outputTokens: 100,
  reasoningTokens: 0,
  elapsedMs: 10,
};

/** 1차 패스가 만든 카드. 뜻과 사례가 비어 있다. */
const card = (n: number, definitionKo = ''): Concept => ({
  id: `c_${n}`,
  name: `concept ${n}`,
  nameKo: `개념 ${n}`,
  definitionKo,
  whyItMatters: `이유 ${n}`,
  exampleKo: null,
  prerequisiteConceptIds: [],
  refs: [],
  researchStatus: 'unresolved',
  contextVersion: 1,
});

const dataOf = (request: LlmJobRequest): { CONCEPTS: Record<string, unknown>[] } =>
  JSON.parse(request.prompt.slice(INPUT_PREAMBLE.length + 1)) as {
    CONCEPTS: Record<string, unknown>[];
  };
const idsOf = (request: LlmJobRequest): string[] =>
  dataOf(request).CONCEPTS.map((c) => String(c['id']));

const answer = (ids: string[]): ConceptCardsModelOutput => ({
  concepts: ids.map((id) => ({ id, definitionKo: `쓴 뜻 ${id}`, exampleKo: `사례 ${id}` })),
});

/** 글이면 실패 종류, 아니면 모델이 돌려준 값이다. */
type Reply = (request: LlmJobRequest, index: number) => unknown;

const runnerOf = (reply: Reply): LlmJobRunner & { requests: LlmJobRequest[] } => {
  const requests: LlmJobRequest[] = [];
  return {
    requests,
    run: (request) => {
      requests.push(request);
      const r = reply(request, requests.length - 1);
      const result: LlmJobResult =
        typeof r === 'string'
          ? {
              ok: false,
              jobId: request.jobId,
              kind: r as LlmJobFailureKind,
              message: `실패 ${r}`,
              errors: [],
              rawText: null,
              model: null,
              usage: USAGE,
            }
          : {
              ok: true,
              jobId: request.jobId,
              value: r,
              rawText: JSON.stringify(r),
              model: 'fake',
              usage: USAGE,
            };
      return Promise.resolve(result);
    },
    cancel: (jobId) => Promise.resolve({ jobId, status: 'not_found' }),
    activeJobIds: () => [],
  };
};

let root: string;
let store: PaperCacheStore;

const seed = async (concepts: Concept[]): Promise<void> => {
  const path = store.generationPath(SHA, GEN, 'context.json');
  const sha = await store.writeJson('contextDocument', path, { ...sampleContext, concepts });
  await store.updateManifest(SHA, (m) => {
    store.recordFile(m, SHA, path, sha);
    m.currentGenerationId = GEN;
    m.state = 'context_pending';
  });
};
const saved = async (): Promise<ContextDocument> => {
  const manifest = await store.readManifest(SHA);
  const sha = manifest.files.find(
    (f) => f.path === join('generations', GEN, 'context.json'),
  )?.sha256;
  return store.readJson('contextDocument', store.generationPath(SHA, GEN, 'context.json'), sha);
};

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'paperlens-cards-'));
  store = new PaperCacheStore(root);
  await store.initPaper(SHA, NOW);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// 요청 순서를 보는 테스트가 많아 기본은 하나씩 돌린다.
const run = (runner: LlmJobRunner, batchSize = 2): ReturnType<typeof runConceptCards> =>
  runConceptCards(
    { store, runner, now: () => NOW },
    { pdfSha256: SHA, generationId: GEN, batchSize, concurrency: 1 },
  );

describe('runConceptCards', () => {
  it('뜻이 빈 카드만 검색 없이 묶어 보내고, 받은 뜻과 사례를 저장한다', async () => {
    await seed([card(1), card(2, '조사로 쓴 뜻'), card(3), card(4)]);
    const runner = runnerOf((request) => answer(idsOf(request)));
    const result = await run(runner);
    expect(result).toMatchObject({ status: 'done', written: 3, empty: 0 });
    expect(runner.requests.map(idsOf)).toEqual([['c_1', 'c_3'], ['c_4']]);
    expect(runner.requests[0]).toMatchObject({
      research: { kind: 'none' },
      outputSchema: CONCEPT_CARDS_OUTPUT_SCHEMA,
    });
    expect(runner.requests[0]?.jobId).toMatch(/^cc_gen_test_/);
    // 입력에는 이름과 이 논문에서 중요한 이유만 준다.
    expect(dataOf(runner.requests[0] as LlmJobRequest).CONCEPTS[0]).toEqual({
      id: 'c_1',
      name: 'concept 1',
      nameKo: '개념 1',
      whyItMatters: '이유 1',
    });

    const context = await saved();
    expect(
      context.concepts.map((c) => [c.id, c.definitionKo, c.exampleKo, c.researchStatus]),
    ).toEqual([
      ['c_1', '쓴 뜻 c_1', '사례 c_1', 'unresolved'],
      ['c_2', '조사로 쓴 뜻', null, 'unresolved'],
      ['c_3', '쓴 뜻 c_3', '사례 c_3', 'unresolved'],
      ['c_4', '쓴 뜻 c_4', '사례 c_4', 'unresolved'],
    ]);
    expect(context.concepts[0]?.whyItMatters).toBe('이유 1');
    expect(await store.verifyFiles(SHA)).toEqual([]);
    expect((await store.readManifest(SHA)).usage.logicalJobs).toBe(2);
  });

  it('뜻이 빈 카드가 없으면 아무것도 보내지 않는다', async () => {
    await seed([card(1, '뜻'), card(2, '뜻')]);
    const runner = runnerOf((request) => answer(idsOf(request)));
    expect(await run(runner)).toEqual({ status: 'skipped', reason: 'nothing_to_write' });
    expect(runner.requests).toHaveLength(0);
  });

  it('청크가 이미 있는 세대에서는 돌지 않는다', async () => {
    await seed([card(1)]);
    const path = store.generationPath(SHA, GEN, 'chunks/chunk_0001.json');
    const sha = await store.writeJson('chunkDocument', path, sampleChunk);
    await store.updateManifest(SHA, (m) => store.recordFile(m, SHA, path, sha));
    const runner = runnerOf((request) => answer(idsOf(request)));
    expect(await run(runner)).toEqual({ status: 'skipped', reason: 'has_chunks' });
    expect(runner.requests).toHaveLength(0);
  });

  it('묶음 하나가 실패해도 나머지는 저장하고, 다시 실행하면 남은 카드만 보낸다', async () => {
    await seed([1, 2, 3, 4].map((n) => card(n)));
    const failing = runnerOf((request, index) =>
      index === 0 ? 'timeout' : answer(idsOf(request)),
    );
    const first = await run(failing);
    expect(first).toMatchObject({ status: 'done', written: 2, empty: 2 });
    expect((await saved()).concepts.map((c) => c.definitionKo)).toEqual([
      '',
      '',
      '쓴 뜻 c_3',
      '쓴 뜻 c_4',
    ]);
    const manifest = await store.readManifest(SHA);
    expect(manifest.errors.map((e) => [e.stage, e.code])).toEqual([
      ['concept_cards', 'batch_timeout'],
    ]);
    expect(manifest.state).toBe('context_pending');

    const runner = runnerOf((request) => answer(idsOf(request)));
    expect(await run(runner)).toMatchObject({ status: 'done', written: 2, empty: 0 });
    expect(runner.requests.map(idsOf)).toEqual([['c_1', 'c_2']]);
  });

  it('모델이 비워 둔 뜻, 묶음에 없는 id, 두 번 돌려준 id는 받지 않는다', async () => {
    await seed([card(1), card(2), card(3)]);
    const runner = runnerOf(() => ({
      concepts: [
        { id: 'c_1', definitionKo: ' 첫 뜻 ', exampleKo: ' ' },
        { id: 'c_1', definitionKo: '두 번째 뜻', exampleKo: '' },
        { id: 'c_2', definitionKo: '  ', exampleKo: '사례만' },
        { id: 'c_9', definitionKo: '없는 카드', exampleKo: '' },
      ],
    }));
    const result = await run(runner, 3);
    expect(result).toMatchObject({ status: 'done', written: 1, empty: 2 });
    expect((await saved()).concepts.map((c) => [c.definitionKo, c.exampleKo])).toEqual([
      ['첫 뜻', null],
      ['', null],
      ['', null],
    ]);
  });

  it('스키마와 맞지 않는 출력은 버리고 기록한다', async () => {
    await seed([card(1)]);
    const result = await run(runnerOf(() => ({ concepts: [{ id: 'c_1' }] })));
    expect(result).toMatchObject({ status: 'done', written: 0, empty: 1 });
    if (result.status !== 'done') throw new Error(result.status);
    expect(result.batches[0]).toMatchObject({ ok: false, failure: 'output_shape' });
    expect((await store.readManifest(SHA)).errors[0]?.code).toBe('batch_output_shape');
  });

  it('한도에 걸리면 새 묶음을 보내지 않고, 그때까지 쓴 카드는 저장한다', async () => {
    await seed([1, 2, 3, 4, 5, 6].map((n) => card(n)));
    const runner = runnerOf((request, index) => (index === 1 ? 'quota' : answer(idsOf(request))));
    const result = await run(runner);
    expect(result).toMatchObject({
      status: 'stopped',
      reason: 'quota',
      written: 2,
      state: 'waiting_quota',
    });
    expect(runner.requests).toHaveLength(2);
    expect((await saved()).concepts.map((c) => c.definitionKo !== '')).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    const manifest = await store.readManifest(SHA);
    expect(manifest.state).toBe('waiting_quota');
    expect(manifest.errors.map((e) => [e.code, e.retryable])).toEqual([['llm_quota', true]]);
    expect(await store.verifyFiles(SHA)).toEqual([]);
  });

  it('context.json을 읽을 수 없으면 멈춘다', async () => {
    const runner = runnerOf((request) => answer(idsOf(request)));
    expect(await run(runner)).toMatchObject({ status: 'stopped', reason: 'no_context' });
    expect(runner.requests).toHaveLength(0);
  });
});
