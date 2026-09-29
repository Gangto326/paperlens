import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Concept, Usage } from '@shared/schema';
import { sampleChunk, sampleContext, sampleExtraction } from '@shared/schema/fixtures';
import { PaperCacheStore } from '../cache/paper-cache-store';
import type { LlmJobFailureKind, LlmJobRequest, LlmJobResult, LlmJobRunner } from '../llm/job';
import type { ResearchTrace } from '../llm/research-trace';
import { INPUT_PREAMBLE } from '../prompt/template';
import {
  batchesOf,
  CONCEPT_RESEARCH_OUTPUT_SCHEMA,
  runConceptResearch,
  type ConceptResearchModelOutput,
} from './concept-research';

const SHA = '5'.repeat(64);
const GEN = 'gen_test';
const NOW = new Date('2026-09-28T00:00:00.000Z');
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

const card = (n: number): Concept => ({
  id: `c_${n}`,
  name: `concept ${n}`,
  nameKo: `개념 ${n}`,
  definitionKo: `일반 뜻 ${n}`,
  whyItMatters: `이유 ${n}`,
  exampleKo: null,
  prerequisiteConceptIds: [],
  refs: [],
  researchStatus: 'unresolved',
  contextVersion: 1,
});

const traceFor = (ids: string[]): ResearchTrace => ({
  queries: ids.map((id) => `${id} 설명`),
  openRequests: [],
  results: ids.flatMap((id) => [
    {
      url: `https://read.example/${id}`,
      title: `${id} 교재`,
      domain: 'read.example',
      viewed: true,
    },
    {
      url: `https://video.example/${id}`,
      title: `${id} 강의`,
      domain: 'video.example',
      viewed: false,
    },
  ]),
  searchItems: ids.length,
  failedViews: 0,
});

const idsOf = (request: LlmJobRequest): string[] => {
  const data = JSON.parse(request.prompt.slice(INPUT_PREAMBLE.length + 1)) as {
    CONCEPTS: { id: string }[];
  };
  return data.CONCEPTS.map((c) => c.id);
};

const source = (url: string, kind = 'article') => ({
  url,
  title: '모델 제목',
  kind,
  language: 'ko',
  supports: '뜻을 설명한다',
});

const answer = (ids: string[]): ConceptResearchModelOutput => ({
  concepts: ids.map((id) => ({
    id,
    definitionKo: `확인한 뜻 ${id}`,
    whyItMatters: '',
    exampleKo: `사례 ${id}`,
    sources: [
      source(`https://read.example/${id}`),
      source(`https://video.example/${id}`, 'video'),
      source(`https://invented.example/${id}`),
    ],
  })),
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
              research: traceFor(idsOf(request)),
            };
      return Promise.resolve(result);
    },
    cancel: (jobId) => Promise.resolve({ jobId, status: 'not_found' }),
    activeJobIds: () => [],
  };
};

let root: string;
let store: PaperCacheStore;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'paperlens-research-'));
  store = new PaperCacheStore(root);
  await store.initPaper(SHA, NOW);
  const path = store.generationPath(SHA, GEN, 'context.json');
  const sha = await store.writeJson('contextDocument', path, {
    ...sampleContext,
    concepts: [1, 2, 3, 4, 5].map(card),
  });
  await store.updateManifest(SHA, (m) => {
    store.recordFile(m, SHA, path, sha);
    m.currentGenerationId = GEN;
    m.state = 'context_pending';
  });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const run = (runner: LlmJobRunner, batchSize = 2): ReturnType<typeof runConceptResearch> =>
  runConceptResearch(
    { store, runner, now: () => NOW },
    { pdfSha256: SHA, generationId: GEN, batchSize },
  );

describe('runConceptResearch', () => {
  it('카드를 묶어 조사하고, 검색 기록과 맞는 출처만 저장한다', async () => {
    const runner = runnerOf((request) => answer(idsOf(request)));
    const result = await run(runner);
    if (result.status !== 'done') throw new Error(result.status);
    expect(runner.requests.map(idsOf)).toEqual([['c_1', 'c_2'], ['c_3', 'c_4'], ['c_5']]);
    expect(runner.requests[0]).toMatchObject({
      research: { kind: 'builtin_web' },
      outputSchema: CONCEPT_RESEARCH_OUTPUT_SCHEMA,
    });
    expect(result).toMatchObject({ researched: 5, sources: 10, state: 'context_pending' });
    expect(result.batches.map((b) => [b.ok, b.accepted, b.rejected.length])).toEqual([
      [true, 4, 2],
      [true, 4, 2],
      [true, 2, 1],
    ]);

    const manifest = await store.readManifest(SHA);
    const hashOf = (file: 'context.json' | 'research.json'): string | undefined =>
      manifest.files.find((f) => f.path === join('generations', GEN, file))?.sha256;
    const saved = await store.readJson(
      'contextDocument',
      store.generationPath(SHA, GEN, 'context.json'),
      hashOf('context.json'),
    );
    expect(saved.concepts[0]).toMatchObject({
      id: 'c_1',
      definitionKo: '확인한 뜻 c_1',
      // 빈 글로 돌려준 칸은 앞선 글을 지킨다.
      whyItMatters: '이유 1',
      exampleKo: '사례 c_1',
      researchStatus: 'researched',
      refs: [{ sourceId: 'src_1', evidenceIds: [], supports: '뜻을 설명한다' }],
      furtherRefs: [{ sourceId: 'src_2' }],
    });
    const research = await store.readJson(
      'researchDocument',
      store.generationPath(SHA, GEN, 'research.json'),
      hashOf('research.json'),
    );
    expect(research.sources.map((s) => [s.id, s.finalUrl, s.fetchStatus]).slice(0, 2)).toEqual([
      ['src_1', 'https://read.example/c_1', 'read'],
      ['src_2', 'https://video.example/c_1', 'not_read'],
    ]);
    expect(JSON.stringify([saved, research])).not.toContain('invented.example');
    expect(manifest.usage.inputTokens).toBe(3000);
    expect(await store.verifyFiles(SHA)).toEqual([]);
  });

  it('묶음 하나가 실패해도 나머지는 계속하고, 실패한 카드는 일반 설명으로 남는다', async () => {
    const runner = runnerOf((request, i) => {
      if (i === 0) return 'timeout';
      if (i === 1) return { concepts: 'broken' };
      return {
        concepts: [
          ...answer(idsOf(request)).concepts,
          { ...answer(['c_1']).concepts[0], id: 'c_1' },
          { ...answer(['c_5']).concepts[0], definitionKo: '두 번째' },
        ],
      };
    });
    const result = await run(runner);
    if (result.status !== 'done') throw new Error(result.status);
    expect(result.batches.map((b) => [b.ok, b.failure])).toEqual([
      [false, 'timeout'],
      [false, 'output_shape'],
      [true, null],
    ]);
    expect(result.context.concepts.map((c) => [c.id, c.researchStatus, c.definitionKo])).toEqual([
      ['c_1', 'unresolved', '일반 뜻 1'],
      ['c_2', 'unresolved', '일반 뜻 2'],
      ['c_3', 'unresolved', '일반 뜻 3'],
      ['c_4', 'unresolved', '일반 뜻 4'],
      ['c_5', 'researched', '확인한 뜻 c_5'],
    ]);
    const manifest = await store.readManifest(SHA);
    expect(manifest.errors.map((e) => [e.stage, e.code])).toEqual([
      ['concept_research', 'batch_timeout'],
      ['concept_research', 'batch_output_shape'],
    ]);
  });

  it('번역 중인 논문 자체는 출처로 저장하지 않고, 논문 제목을 조사 입력에 넣는다', async () => {
    const revision = 'rev_1';
    const self = 'https://arxiv.org/abs/2005.11401';
    const documentPath = store.extractionPath(SHA, revision, 'document.json');
    const documentSha = await store.writeJson('extractionDocument', documentPath, {
      ...sampleExtraction,
      paper: { ...sampleExtraction.paper, title: '논문 제목', fileName: '2005.11401.pdf' },
    });
    await store.updateManifest(SHA, (m) => {
      store.recordFile(m, SHA, documentPath, documentSha);
      m.currentExtractionRevision = revision;
    });
    const base = runnerOf((request) => ({
      concepts: answer(idsOf(request)).concepts.map((c) => ({
        ...c,
        sources: [source(self, 'paper'), source(`https://read.example/${c.id}`)],
      })),
    }));
    const runner: LlmJobRunner = {
      ...base,
      run: async (request, onEvent) => {
        const result = await base.run(request, onEvent);
        if (!result.ok || !result.research) return result;
        const entry = { url: self, title: '다른 제목', domain: 'arxiv.org', viewed: true };
        return {
          ...result,
          research: { ...result.research, results: [...result.research.results, entry] },
        };
      },
    };
    const result = await run(runner, 5);
    if (result.status !== 'done') throw new Error(result.status);
    expect(result).toMatchObject({ researched: 5, sources: 5 });
    expect(result.batches[0]?.rejected).toEqual(
      [1, 2, 3, 4, 5].map(() => ({ url: self, reason: 'self_paper' })),
    );
    expect(result.context.concepts.map((c) => c.refs.length)).toEqual([1, 1, 1, 1, 1]);
    const input = JSON.parse((base.requests[0]?.prompt ?? '').slice(INPUT_PREAMBLE.length + 1)) as {
      PAPER_CONTEXT: { title: string | null };
    };
    expect(input.PAPER_CONTEXT.title).toBe('논문 제목');
  });

  it('검색 기록이 없는 결과의 출처는 모두 버리고 카드는 출처 미확인으로 남는다', async () => {
    const runner = runnerOf((request) => answer(idsOf(request)));
    const original = runner.run.bind(runner);
    runner.run = async (request, onEvent) => {
      const r = await original(request, onEvent);
      if (r.ok) delete r.research;
      return r;
    };
    const result = await run(runner, 5);
    if (result.status !== 'done') throw new Error(result.status);
    expect(result).toMatchObject({ researched: 0, sources: 0 });
    expect(result.batches[0]?.rejected).toHaveLength(15);
    expect(result.context.concepts[0]).toMatchObject({
      definitionKo: '확인한 뜻 c_1',
      researchStatus: 'unresolved',
      refs: [],
    });
  });

  it('로그인 필요·한도 초과·런타임 없음은 멈추고 아무것도 저장하지 않는다', async () => {
    const cases: [LlmJobFailureKind, string, string][] = [
      ['quota', 'quota', 'waiting_quota'],
      ['needs_login', 'needs_login', 'needs_login'],
      ['unsupported_policy', 'unavailable', 'context_pending'],
    ];
    for (const [kind, reason, state] of cases) {
      const runner = runnerOf((request, i) => (i === 1 ? kind : answer(idsOf(request))));
      const result = await run(runner);
      expect(result).toMatchObject({ status: 'stopped', reason, state });
      expect(runner.requests).toHaveLength(2);
      const manifest = await store.readManifest(SHA);
      expect(manifest.files.map((f) => f.path)).toEqual([join('generations', GEN, 'context.json')]);
      expect(await store.verifyFiles(SHA)).toEqual([]);
      await store.updateManifest(SHA, (m) => {
        m.state = 'context_pending';
      });
    }
  });

  it('끝난 패스, 카드 없는 세대, 청크가 이미 있는 세대에서는 돌지 않는다', async () => {
    const runner = runnerOf((request) => answer(idsOf(request)));
    expect((await run(runner)).status).toBe('done');
    const before = runner.requests.length;
    expect(await run(runner)).toEqual({ status: 'skipped', reason: 'already_done' });
    expect(runner.requests).toHaveLength(before);

    await store.updateManifest(SHA, (m) => {
      m.files = m.files.filter((f) => !f.path.endsWith('research.json'));
    });
    const chunkPath = store.generationPath(SHA, GEN, 'chunks/chunk_0001.json');
    const chunkSha = await store.writeJson('chunkDocument', chunkPath, sampleChunk);
    await store.updateManifest(SHA, (m) => store.recordFile(m, SHA, chunkPath, chunkSha));
    expect(await run(runner)).toEqual({ status: 'skipped', reason: 'has_chunks' });

    const other = 'gen_empty';
    const path = store.generationPath(SHA, other, 'context.json');
    const sha = await store.writeJson('contextDocument', path, { ...sampleContext, concepts: [] });
    await store.updateManifest(SHA, (m) => store.recordFile(m, SHA, path, sha));
    expect(
      await runConceptResearch(
        { store, runner, now: () => NOW },
        { pdfSha256: SHA, generationId: other },
      ),
    ).toEqual({ status: 'skipped', reason: 'no_concepts' });
  });
});

describe('batchesOf', () => {
  it('크기대로 나누고 0 이하는 1로 본다', () => {
    expect(batchesOf([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(batchesOf([1, 2], 0)).toEqual([[1], [2]]);
    expect(batchesOf([], 3)).toEqual([]);
  });
});
