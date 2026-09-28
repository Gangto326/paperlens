import { describe, expect, it } from 'vitest';
import { normalizeUrl, standingOf } from '../research-trace';
import { researchTraceOf } from './codex-research';

/** 0.157.1 실제 턴에서 본 항목의 모양을 줄인 것. */
const ITEMS: unknown[] = [
  { type: 'userMessage', id: 'u1', content: [] },
  {
    type: 'webSearch',
    id: 'w1',
    query: 'BM25 …',
    action: { type: 'search', query: null, queries: ['BM25 한국어 설명', 'Okapi BM25'] },
    results: [
      {
        type: 'text_result',
        domain: 'www.elastic.co',
        ref_id: 'turn0search0',
        title: '실용적인 BM25',
        url: 'https://www.elastic.co/kr/blog/practical-bm25',
        snippet: '…',
      },
      {
        type: 'text_result',
        domain: 'www.youtube.com',
        ref_id: 'turn0youtube3',
        title: 'BM25 강의',
        url: 'https://www.youtube.com/watch?v=abc',
      },
    ],
  },
  { type: 'reasoning', id: 'r1', summary: [], content: [] },
  {
    type: 'webSearch',
    id: 'w2',
    query: 'https://www.youtube.com/watch?v=abc',
    action: { type: 'openPage', url: 'https://www.youtube.com/watch?v=abc' },
    results: [
      {
        type: 'text_result',
        ref_id: 'turn1view0',
        title: 'Internal Error',
        snippet: 'Total lines: 1',
      },
      {
        type: 'text_result',
        domain: 'www.elastic.co',
        ref_id: 'turn1view1',
        title: '실용적인 BM25',
        url: 'https://www.elastic.co/kr/blog/practical-bm25/',
      },
    ],
  },
  { type: 'webSearch', id: 'w3', query: '', action: { type: 'other' }, results: 'broken' },
  { type: 'agentMessage', id: 'a1', text: '{}' },
];

describe('researchTraceOf', () => {
  it('검색어, 열려고 한 주소, 결과 주소를 모으고 열람 여부를 구분한다', () => {
    const trace = researchTraceOf(ITEMS);
    expect(trace).toEqual({
      queries: ['BM25 한국어 설명', 'Okapi BM25'],
      openRequests: ['https://www.youtube.com/watch?v=abc'],
      results: [
        {
          url: 'https://www.elastic.co/kr/blog/practical-bm25',
          title: '실용적인 BM25',
          domain: 'www.elastic.co',
          viewed: true,
        },
        {
          url: 'https://www.youtube.com/watch?v=abc',
          title: 'BM25 강의',
          domain: 'www.youtube.com',
          viewed: false,
        },
      ],
      searchItems: 3,
      failedViews: 1,
    });
  });

  it('검색 항목이 없거나 모양이 다르면 빈 기록이다', () => {
    expect(researchTraceOf([{ type: 'agentMessage' }, null, 'x', { type: 'webSearch' }])).toEqual({
      queries: [],
      openRequests: [],
      results: [],
      searchItems: 1,
      failedViews: 0,
    });
  });
});

describe('standingOf · normalizeUrl', () => {
  const trace = researchTraceOf(ITEMS);
  it('열람한 주소, 결과에만 나온 주소, 기록에 없는 주소를 구분한다', () => {
    expect(standingOf(trace, 'https://www.elastic.co/kr/blog/practical-bm25/#tf')).toBe('viewed');
    // 열려고 했지만 열람에 실패한 영상은 결과에만 나온 것으로 본다.
    expect(standingOf(trace, 'https://www.youtube.com/watch?v=abc')).toBe('listed');
    expect(standingOf(trace, 'https://www.youtube.com/watch?v=other')).toBe('absent');
    expect(standingOf(trace, 'https://elastic.co/kr/blog/practical-bm25')).toBe('absent');
    expect(standingOf(trace, 'javascript:alert(1)')).toBe('absent');
  });

  it('조각과 끝의 빗금, 호스트의 대소문자만 무시한다', () => {
    expect(normalizeUrl('HTTPS://Example.ORG/A/?q=1#x')).toBe('https://example.org/A/?q=1');
    expect(normalizeUrl('https://example.org/')).toBe('https://example.org');
    expect(normalizeUrl('ftp://example.org')).toBeNull();
    expect(normalizeUrl('그냥 글')).toBeNull();
  });
});
