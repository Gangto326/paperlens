import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExtractionDocument, Section, Sentence, Usage } from '@shared/schema';
import { sampleExtraction } from '@shared/schema/fixtures';
import { PaperCacheStore } from '../cache/paper-cache-store';
import type { ContextBodySection } from '../context/context-input';
import type { LlmJobFailureKind, LlmJobRequest, LlmJobResult, LlmJobRunner } from '../llm/job';
import { INPUT_PREAMBLE } from '../prompt/template';
import type { ChunkPromptInputs } from '../translate/chunk-input';
import { PaperScheduler, type SchedulerEvent } from './paper-scheduler';

const SHA = 'f'.repeat(64);
const REV = 'rtest';
const NOW = new Date('2026-09-27T13:00:00.000Z');
const USAGE: Usage = {
  logicalJobs: 1,
  turnCount: 1,
  reportedModelCalls: null,
  inputTokens: 100,
  cachedInputTokens: 0,
  outputTokens: 10,
  reasoningTokens: 1,
  elapsedMs: 5,
};

/** 섹션 3개, 섹션마다 문장 2개. 문장 하나는 100토큰(400자)이다. */
const makeDocument = (): ExtractionDocument => {
  const sections: Section[] = [];
  const sentences: Sentence[] = [];
  for (let i = 0; i < 3; i += 1) {
    const ids: string[] = [];
    for (let k = 0; k < 2; k += 1) {
      const id = `id_${i}_${k}`;
      ids.push(id);
      const en = `Sentence ${i}.${k} ${'x'.repeat(386)}`;
      sentences.push({
        id,
        order: sentences.length,
        page: 0,
        pages: [0],
        sectionId: `sec_${i}`,
        paragraphId: `p_${i}`,
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
    }
    sections.push({ id: `sec_${i}`, title: `Section ${i}`, order: i, sentenceIds: ids });
  }
  return { ...sampleExtraction, sections, sentences };
};

let root: string;
let store: PaperCacheStore;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'paperlens-scheduler-'));
  store = new PaperCacheStore(root);
  await store.initPaper(SHA, NOW);
  const path = store.extractionPath(SHA, REV, 'document.json');
  const sha = await store.writeJson('extractionDocument', path, makeDocument());
  await store.updateManifest(SHA, (m) => {
    store.recordFile(m, SHA, path, sha);
    m.currentExtractionRevision = REV;
    m.state = 'mapping';
  });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const dataOf = (request: LlmJobRequest): Record<string, unknown> =>
  JSON.parse(request.prompt.slice(INPUT_PREAMBLE.length + 1)) as Record<string, unknown>;
const isContext = (request: LlmJobRequest): boolean => request.jobId.startsWith('ctx_');

const contextValue = (request: LlmJobRequest): unknown => {
  const body = dataOf(request)['PAPER_BODY'] as ContextBodySection[];
  return {
    summary: '요약',
    researchQuestion: '문제',
    contributions: [],
    methodOverview: '방법',
    mainResults: [],
    limitations: [],
    glossary: [
      {
        term: 'sentence',
        aliases: [],
        preferredKo: '문장',
        displayRule: '',
        meaningInPaper: '',
        evidenceSentenceIds: [],
      },
    ],
    unresolved: [],
    coverage: body.map((s) => ({
      sectionId: s.id,
      startSentenceId: s.sentences[0]?.id ?? '',
      endSentenceId: s.sentences.at(-1)?.id ?? '',
      status: 'covered',
    })),
  };
};
const chunkValue = (request: LlmJobRequest): unknown => {
  const inputs = dataOf(request) as unknown as ChunkPromptInputs;
  return {
    kind: 'results',
    results: inputs.TARGET_SENTENCES.map((s) => ({
      id: s.id,
      ko: `번역 ${s.id}`,
      note: '',
      warnings: [],
    })),
  };
};

type Rule = (request: LlmJobRequest, index: number) => LlmJobFailureKind | 'empty' | null;

const runnerOf = (
  rule: Rule = () => null,
  hook: (request: LlmJobRequest) => void = () => undefined,
): LlmJobRunner & { requests: LlmJobRequest[] } => {
  const requests: LlmJobRequest[] = [];
  return {
    requests,
    run: (request) => {
      const verdict = rule(request, requests.length);
      requests.push(request);
      hook(request);
      if (verdict !== null && verdict !== 'empty') {
        const failed: LlmJobResult = {
          ok: false,
          jobId: request.jobId,
          kind: verdict,
          message: `실패 ${verdict}`,
          errors: [],
          rawText: null,
          model: null,
          usage: USAGE,
        };
        return Promise.resolve(failed);
      }
      const value =
        verdict === 'empty'
          ? { kind: 'results', results: [] }
          : isContext(request)
            ? contextValue(request)
            : chunkValue(request);
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

// 청크 하나에 문장 2개(한 섹션)가 들어가도록 나눈다.
const CHUNKER = { minTokens: 150, maxTokens: 250, neighborSentences: 1 };
const scheduler = (runner: LlmJobRunner, over: { maxFailedChunks?: number } = {}): PaperScheduler =>
  new PaperScheduler({
    store,
    runner,
    provider: 'codex',
    runtimeVersion: () => '0.157.1',
    chunker: CHUNKER,
    now: () => NOW,
    ...over,
  });
const shape = (events: SchedulerEvent[]): string[] =>
  events.map((e) => {
    switch (e.type) {
      case 'state':
        return `state:${e.state}`;
      case 'context':
        return `context:${e.status}`;
      case 'chunk_started':
        return `start:${e.chunkId}`;
      case 'chunk_finished':
        return `finish:${e.chunkId}:${e.ok ? 'ok' : 'fail'}:${e.completed}/${e.total}`;
      case 'finished':
        return `finished:${e.outcome.reason}:${e.state}`;
      default:
        return e.type;
    }
  });

describe('PaperScheduler', () => {
  it('컨텍스트 → translating → 청크를 앞에서부터 하나씩 → complete', async () => {
    const runner = runnerOf();
    const s = scheduler(runner);
    const events: SchedulerEvent[] = [];
    s.onEvent((e) => events.push(e));
    const outcome = await s.run(SHA);

    expect(outcome).toMatchObject({
      reason: 'complete',
      totalChunks: 3,
      completedChunks: 3,
      failedChunks: 0,
    });
    expect(shape(events)).toEqual([
      'started',
      'state:context_pending',
      'context:running',
      'context:done',
      'state:translating',
      'plan',
      'start:chunk_0001',
      'finish:chunk_0001:ok:1/3',
      'start:chunk_0002',
      'finish:chunk_0002:ok:2/3',
      'start:chunk_0003',
      'finish:chunk_0003:ok:3/3',
      'state:complete',
      'finished:complete:complete',
    ]);
    expect(runner.requests.map((r) => r.jobId.replace(/^.*_(chunk_\d+_\d+)$/, '$1'))).toEqual([
      expect.stringMatching(/^ctx_/),
      'chunk_0001_1',
      'chunk_0002_1',
      'chunk_0003_1',
    ]);
    const finished = events.find((e) => e.type === 'chunk_finished');
    expect(finished?.type === 'chunk_finished' ? finished.sentenceIds : []).toEqual([
      'id_0_0',
      'id_0_1',
    ]);

    const manifest = await store.readManifest(SHA);
    expect(manifest.state).toBe('complete');
    expect(manifest.usage).toMatchObject({ logicalJobs: 4, inputTokens: 400, outputTokens: 40 });
    expect(manifest.files.map((f) => f.path).filter((p) => p.includes('chunks/'))).toHaveLength(3);
    expect(await store.verifyFiles(SHA)).toEqual([]);

    // 청크별 입력·출력 토큰과 시간 기록(PLAN 11.2)
    expect(outcome.metrics.map((m) => [m.chunkId, m.outcome, m.sentences, m.inputTokens])).toEqual([
      ['chunk_0001', 'complete', 2, 100],
      ['chunk_0002', 'complete', 2, 100],
      ['chunk_0003', 'complete', 2, 100],
    ]);
    expect(outcome.firstTranslationMs).not.toBeNull();
    expect(outcome.contextUsage).toMatchObject({ inputTokens: 100 });
    const dir = join(store.paperDir(SHA), 'generations', outcome.generationId ?? '', 'diagnostics');
    expect(await fs.readdir(dir)).toEqual(['run-20260927T130000Z.json']);
  });

  it('다시 시작하면 컨텍스트와 완료 청크를 다시 요청하지 않는다', async () => {
    const first = runnerOf();
    await scheduler(first).run(SHA);
    await store.updateManifest(SHA, (m) => {
      m.state = 'paused';
    });
    const second = runnerOf();
    const events: SchedulerEvent[] = [];
    const s = scheduler(second);
    s.onEvent((e) => events.push(e));
    const outcome = await s.run(SHA);
    expect(second.requests).toEqual([]);
    expect(outcome).toMatchObject({ reason: 'complete', completedChunks: 3 });
    expect(outcome.metrics.map((m) => m.outcome)).toEqual(['reused', 'reused', 'reused']);
    expect(outcome.firstTranslationMs).toBeNull();
    expect(shape(events).slice(0, 3)).toEqual(['started', 'context:reused', 'state:translating']);
    expect((await store.readManifest(SHA)).usage.logicalJobs).toBe(4);
  });

  it('한도에 걸리면 멈추고, 다시 시작하면 남은 청크부터 이어서 한다', async () => {
    const limited = runnerOf((request) => (request.jobId.includes('chunk_0002') ? 'quota' : null));
    const stopped = await scheduler(limited).run(SHA);
    expect(stopped).toMatchObject({
      reason: 'waiting_quota',
      completedChunks: 1,
      failedChunks: 1,
      totalChunks: 3,
    });
    expect((await store.readManifest(SHA)).state).toBe('waiting_quota');
    expect(limited.requests.some((r) => r.jobId.includes('chunk_0003'))).toBe(false);

    const resumed = runnerOf();
    const outcome = await scheduler(resumed).run(SHA);
    expect(outcome).toMatchObject({ reason: 'complete', completedChunks: 3, failedChunks: 0 });
    // 컨텍스트와 첫 청크는 다시 보내지 않는다. 실패했던 청크는 요청 번호를 이어서 센다.
    expect(resumed.requests.map((r) => r.jobId.replace(/^.*_(chunk_\d+_\d+)$/, '$1'))).toEqual([
      'chunk_0002_2',
      'chunk_0003_1',
    ]);
    expect((await store.readManifest(SHA)).state).toBe('complete');
  });

  it('컨텍스트에서 로그인이 필요하면 청크를 보내지 않는다', async () => {
    const runner = runnerOf(() => 'needs_login');
    const outcome = await scheduler(runner).run(SHA);
    expect(outcome).toMatchObject({ reason: 'needs_login', totalChunks: 0 });
    expect(runner.requests).toHaveLength(1);
    expect((await store.readManifest(SHA)).state).toBe('needs_login');
  });

  it('청크가 끝까지 실패해도 다음 청크로 넘어가고 complete_with_gaps로 끝난다', async () => {
    const runner = runnerOf((request) => (request.jobId.includes('chunk_0002') ? 'empty' : null));
    const outcome = await scheduler(runner).run(SHA);
    expect(outcome).toMatchObject({
      reason: 'complete_with_gaps',
      completedChunks: 2,
      failedChunks: 1,
    });
    expect(outcome.metrics[1]).toMatchObject({
      chunkId: 'chunk_0002',
      outcome: 'failed',
      requests: 4,
      failureCode: 'chunk_missing_id',
    });
    expect((await store.readManifest(SHA)).state).toBe('complete_with_gaps');
  });

  it('실패한 청크가 상한에 닿으면 남은 청크를 보내지 않는다', async () => {
    const runner = runnerOf((request) => (isContext(request) ? null : 'empty'));
    const outcome = await scheduler(runner, { maxFailedChunks: 2 }).run(SHA);
    expect(outcome).toMatchObject({ reason: 'too_many_failures', failedChunks: 2 });
    expect(runner.requests.some((r) => r.jobId.includes('chunk_0003'))).toBe(false);
    expect((await store.readManifest(SHA)).state).toBe('failed');
  });

  it('멈춤 요청은 돌고 있는 청크를 끝낸 뒤에 적용된다', async () => {
    const holder: { s: PaperScheduler | null } = { s: null };
    const runner = runnerOf(
      () => null,
      (request) => {
        if (request.jobId.includes('chunk_0001')) expect(holder.s?.requestStop()).toBe(true);
      },
    );
    const s = scheduler(runner);
    holder.s = s;
    const outcome = await s.run(SHA);
    expect(outcome).toMatchObject({ reason: 'paused', completedChunks: 1, totalChunks: 3 });
    expect((await store.readManifest(SHA)).state).toBe('paused');
    expect(s.runningPaper).toBeNull();
    expect(s.requestStop()).toBe(false);
  });

  it('뒤쪽 문장을 고르면 다음 청크가 그 청크에서 시작하고 돌던 요청은 취소하지 않는다', async () => {
    const holder: { s: PaperScheduler | null; raised: string[][] } = { s: null, raised: [] };
    const cancelled: string[] = [];
    const base = runnerOf(
      () => null,
      (request) => {
        // 첫 청크가 도는 동안 셋째 청크의 문장을 고른다.
        if (request.jobId.includes('chunk_0001')) {
          holder.raised.push(holder.s?.prioritizeSentences(SHA, ['id_2_1']) ?? []);
        }
      },
    );
    const runner: LlmJobRunner = {
      run: (request, onEvent) => base.run(request, onEvent),
      activeJobIds: () => base.activeJobIds(),
      cancel: (jobId) => {
        cancelled.push(jobId);
        return base.cancel(jobId);
      },
    };
    const s = scheduler(runner);
    holder.s = s;
    const events: SchedulerEvent[] = [];
    s.onEvent((e) => events.push(e));
    const outcome = await s.run(SHA);
    expect(holder.raised).toEqual([['chunk_0003']]);
    expect(outcome).toMatchObject({ reason: 'complete', completedChunks: 3 });
    expect(shape(events).filter((e) => e.startsWith('start:'))).toEqual([
      'start:chunk_0001',
      'start:chunk_0003',
      'start:chunk_0002',
    ]);
    expect(shape(events).filter((e) => e.startsWith('finish:'))[0]).toBe(
      'finish:chunk_0001:ok:1/3',
    );
    expect(cancelled).toEqual([]);
  });

  it('돌고 있거나 끝난 청크, 모르는 문장, 다른 논문은 올리지 않는다', async () => {
    const holder: { s: PaperScheduler | null; raised: string[][] } = { s: null, raised: [] };
    const runner = runnerOf(
      () => null,
      (request) => {
        const s = holder.s;
        if (!s || !request.jobId.includes('chunk_0002')) return;
        holder.raised.push(s.prioritizeSentences(SHA, ['id_0_0'])); // 끝난 청크
        holder.raised.push(s.prioritizeSentences(SHA, ['id_1_0'])); // 돌고 있는 청크
        holder.raised.push(s.prioritizeSentences(SHA, ['nope']));
        holder.raised.push(s.prioritizeSentences('a'.repeat(64), ['id_2_0']));
        holder.raised.push(s.prioritizeSentences(SHA, ['id_2_0', 'id_2_1', 'id_0_0']));
      },
    );
    const s = scheduler(runner);
    holder.s = s;
    await s.run(SHA);
    expect(holder.raised).toEqual([[], [], [], [], ['chunk_0003']]);
    // 실행이 끝나면 올릴 것이 없다.
    expect(s.prioritizeSentences(SHA, ['id_2_0'])).toEqual([]);
  });

  it('컨텍스트 단계에는 올릴 수 없고, 여러 번 고르면 마지막에 고른 청크가 먼저다', async () => {
    const holder: { s: PaperScheduler | null; early: string[] | null } = { s: null, early: null };
    const runner = runnerOf(
      () => null,
      (request) => {
        if (isContext(request)) holder.early = holder.s?.prioritizeSentences(SHA, ['id_2_0']) ?? [];
      },
    );
    const s = scheduler(runner);
    holder.s = s;
    const order: string[] = [];
    s.onEvent((e) => {
      if (e.type === 'plan') {
        s.prioritizeSentences(SHA, ['id_1_0']);
        s.prioritizeSentences(SHA, ['id_2_0']);
      }
      if (e.type === 'chunk_started') order.push(e.chunkId);
    });
    await s.run(SHA);
    expect(holder.early).toEqual([]);
    expect(order).toEqual(['chunk_0003', 'chunk_0002', 'chunk_0001']);
  });

  it('동시에 하나만 돈다', async () => {
    const holder: { s: PaperScheduler | null; second: Promise<unknown> | null } = {
      s: null,
      second: null,
    };
    const runner = runnerOf(
      () => null,
      (request) => {
        if (isContext(request)) holder.second = holder.s?.run('a'.repeat(64)) ?? null;
      },
    );
    const s = scheduler(runner);
    holder.s = s;
    const outcome = await s.run(SHA);
    expect(outcome.reason).toBe('complete');
    expect(await holder.second).toMatchObject({ reason: 'busy' });
  });

  it('시작할 수 없는 상태와 문서가 없는 논문은 모델을 부르지 않는다', async () => {
    const runner = runnerOf();
    await store.updateManifest(SHA, (m) => {
      m.state = 'extracting';
    });
    expect(await scheduler(runner).run(SHA)).toMatchObject({ reason: 'invalid_state' });
    await store.updateManifest(SHA, (m) => {
      m.state = 'mapping';
      m.currentExtractionRevision = 'rmissing';
    });
    expect(await scheduler(runner).run(SHA)).toMatchObject({ reason: 'no_document' });
    expect(runner.requests).toEqual([]);
  });
});
