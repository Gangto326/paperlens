import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sampleExtraction } from '@shared/schema/fixtures';
import type { Preparation } from '@shared/work-status';
import type { LlmJobRequest, LlmJobResult, LlmJobRunner } from '../llm/job';
import { PaperCacheStore } from '../cache/paper-cache-store';
import { PreparationService } from './preparation';

let root: string;
let store: PaperCacheStore;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'paperlens-preparation-'));
  store = new PaperCacheStore(root);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const sha = sampleExtraction.paper.pdfSha256;
const resource = (url: string) => ({
  title: '모델 제목',
  url,
  topic: '배경 개념',
  reason: '이 논문의 방법을 이해하는 기초입니다.',
  kind: 'article',
  language: '한국어',
});
const success = (): LlmJobResult => ({
  ok: true,
  jobId: 'prep',
  model: null,
  rawText: '{}',
  usage: { logicalJobs: 1, turnCount: 1, inputTokens: 0, outputTokens: 0, elapsedMs: 1 },
  value: {
    resources: [
      resource('https://example.org/intro'),
      resource('https://invented.invalid/a'),
      resource('https://example.org/intro'),
    ],
  },
  research: {
    queries: ['intro'],
    openRequests: [],
    searchItems: 1,
    failedViews: 0,
    results: [
      {
        url: 'https://example.org/intro',
        title: '검색에서 실제 확인한 제목',
        domain: 'example.org',
        viewed: false,
      },
    ],
  },
});
const runner = (run: (request: LlmJobRequest) => Promise<LlmJobResult>): LlmJobRunner => ({
  run,
  cancel: (id) => Promise.resolve({ jobId: id, status: 'not_found' }),
  activeJobIds: () => [],
});

describe('번역 전 입문 자료', () => {
  it('검색 기록 없는 URL과 중복을 제외하고 확인된 제목·열람 여부를 보존한다', async () => {
    const events: Preparation[] = [];
    const service = new PreparationService(
      store,
      runner(() => Promise.resolve(success())),
      (p) => events.push(p),
    );
    await service.start(sampleExtraction);
    expect(events[0]?.status).toBe('searching');
    const last = events.at(-1)!;
    expect(last.status).toBe('ready');
    expect(last.resources).toEqual([
      {
        ...resource('https://example.org/intro'),
        title: '검색에서 실제 확인한 제목',
        verified: 'listed',
      },
    ]);
    const reread = new PreparationService(
      store,
      runner(() => {
        throw new Error('재호출하면 안 됨');
      }),
      () => {},
    );
    expect((await reread.read(sha)).resources).toEqual(last.resources);
    await reread.start(sampleExtraction);
  });
  it('같은 논문의 동시 요청을 하나로 합친다', async () => {
    let resolve!: (result: LlmJobResult) => void;
    let calls = 0;
    const service = new PreparationService(
      store,
      runner(() => {
        calls++;
        return new Promise((r) => {
          resolve = r;
        });
      }),
      () => {},
    );
    const a = service.start(sampleExtraction);
    const b = service.start(sampleExtraction, true);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
    resolve(success());
    await Promise.all([a, b]);
  });
  it('검색 실패를 자료 없음으로 표시하며 예외를 번역 작업으로 전파하지 않는다', async () => {
    const service = new PreparationService(
      store,
      runner(() => {
        throw new Error('실패');
      }),
      () => {},
    );
    await expect(service.start(sampleExtraction)).resolves.toBeUndefined();
    expect((await service.read(sha)).status).toBe('unavailable');
  });
  it('검색을 끈 경우 모델 요청을 보내지 않는다', async () => {
    const service = new PreparationService(
      store,
      runner(() => {
        throw new Error('호출하면 안 됨');
      }),
      () => {},
      false,
    );
    await service.start(sampleExtraction);
    expect((await service.read(sha)).status).toBe('unavailable');
  });
  it('유튜브 검색 결과 페이지는 영상으로 추천하지 않는다', async () => {
    const result = success();
    if (!result.ok) throw new Error();
    result.value = {
      resources: [
        { ...resource('https://www.youtube.com/results?search_query=rag'), kind: 'video' },
      ],
    };
    result.research!.results = [
      {
        url: 'https://www.youtube.com/results?search_query=rag',
        title: '검색 결과',
        domain: 'youtube.com',
        viewed: false,
      },
    ];
    const service = new PreparationService(
      store,
      runner(() => Promise.resolve(result)),
      () => {},
    );
    await service.start(sampleExtraction);
    expect((await service.read(sha)).resources).toEqual([]);
  });
});
