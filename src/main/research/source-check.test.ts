import { describe, expect, it } from 'vitest';
import type { ResearchTrace } from '../llm/research-trace';
import { SourceRegistry, type ClaimedSource } from './source-check';

const NOW = new Date('2026-09-28T00:00:00.000Z');
const TRACE: ResearchTrace = {
  queries: ['bm25'],
  openRequests: ['https://video.example/watch?v=1'],
  results: [
    { url: 'https://example.org/bm25', title: 'BM25 교재', domain: 'example.org', viewed: true },
    {
      url: 'https://video.example/watch?v=1',
      title: 'BM25 강의',
      domain: 'video.example',
      viewed: false,
    },
  ],
  searchItems: 2,
  failedViews: 1,
};
const claim = (url: string, over: Partial<ClaimedSource> = {}): ClaimedSource => ({
  url,
  title: '모델이 적은 제목',
  kind: 'article',
  language: 'ko',
  supports: '뜻',
  ...over,
});

describe('SourceRegistry.check', () => {
  it('읽은 자료와 더 볼 자료를 나누고 기록에 없는 주소는 거절한다', () => {
    const registry = new SourceRegistry([], () => NOW);
    const checked = registry.check(
      [
        claim('https://example.org/bm25/#tf'),
        claim('https://video.example/watch?v=1', { kind: 'video' }),
        claim('https://invented.example/bm25'),
        claim('javascript:alert(1)'),
        claim('https://example.org/bm25'),
      ],
      TRACE,
      { jobId: 'job_1' },
    );
    expect(checked.refs).toEqual([{ sourceId: 'src_1', evidenceIds: [], supports: '뜻' }]);
    expect(checked.furtherRefs).toEqual([{ sourceId: 'src_2', evidenceIds: [], supports: '뜻' }]);
    expect(checked.rejected).toEqual([
      { url: 'https://invented.example/bm25', reason: 'not_in_trace' },
      { url: 'javascript:alert(1)', reason: 'invalid_url' },
    ]);
    expect(registry.sources()).toEqual([
      {
        id: 'src_1',
        discoveredUrl: 'https://example.org/bm25',
        finalUrl: 'https://example.org/bm25',
        title: 'BM25 교재',
        publisher: 'example.org',
        sourceType: 'article',
        discoveredBy: 'search',
        discoveredAt: NOW.toISOString(),
        fetchStatus: 'read',
        evidenceIds: [],
        language: 'ko',
        jobId: 'job_1',
      },
      expect.objectContaining({
        id: 'src_2',
        finalUrl: 'https://video.example/watch?v=1',
        title: 'BM25 강의',
        sourceType: 'video',
        fetchStatus: 'not_read',
      }),
    ]);
  });

  it('검색 기록이 비어 있으면 모든 출처를 거절한다', () => {
    const registry = new SourceRegistry([], () => NOW);
    const empty: ResearchTrace = {
      queries: [],
      openRequests: [],
      results: [],
      searchItems: 0,
      failedViews: 0,
    };
    const checked = registry.check([claim('https://example.org/bm25')], empty, { jobId: 'j' });
    expect(checked.refs).toEqual([]);
    expect(checked.rejected).toHaveLength(1);
    expect(registry.sources()).toEqual([]);
  });

  it('다른 작업에서 같은 주소가 나오면 같은 id를 쓰고, 읽은 자료는 읽은 자료로 남는다', () => {
    const registry = new SourceRegistry([], () => NOW);
    const listedOnly: ResearchTrace = {
      ...TRACE,
      results: TRACE.results.map((r) => ({ ...r, viewed: false })),
    };
    const first = registry.check([claim('https://example.org/bm25')], listedOnly, { jobId: 'a' });
    expect(first.furtherRefs.map((r) => r.sourceId)).toEqual(['src_1']);
    const second = registry.check([claim('https://example.org/bm25')], TRACE, { jobId: 'b' });
    expect(second.refs.map((r) => r.sourceId)).toEqual(['src_1']);
    const third = registry.check([claim('https://example.org/bm25')], listedOnly, { jobId: 'c' });
    expect(third.furtherRefs.map((r) => r.sourceId)).toEqual(['src_1']);
    expect(registry.sources()).toHaveLength(1);
    expect(registry.sources()[0]).toMatchObject({ fetchStatus: 'read', jobId: 'a' });

    const reopened = new SourceRegistry(registry.sources(), () => NOW);
    const again = reopened.check([claim('https://video.example/watch?v=1')], TRACE, {
      jobId: 'd',
    });
    expect(again.furtherRefs.map((r) => r.sourceId)).toEqual(['src_2']);
  });
});
