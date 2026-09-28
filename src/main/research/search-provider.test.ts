import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CandidateRegistry,
  DUCKDUCKGO_HTML_ENDPOINT,
  decodeEntities,
  duckDuckGoHtmlProvider,
  parseDuckDuckGoHtml,
  unwrapDuckDuckGoLink,
  type HttpFunction,
  type HttpRequest,
} from './search-provider';

const FIXTURE = readFileSync(join(__dirname, '__fixtures__', 'duckduckgo-results.html'), 'utf8');
const NOW = new Date('2026-09-28T00:00:00.000Z');

const httpOf = (
  reply: (request: HttpRequest) => { status: number; body: string } | Error,
): HttpFunction & { requests: HttpRequest[] } => {
  const requests: HttpRequest[] = [];
  const http = ((request) => {
    requests.push(request);
    const r = reply(request);
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  }) as HttpFunction & { requests: HttpRequest[] };
  http.requests = requests;
  return http;
};

describe('parseDuckDuckGoHtml', () => {
  it('결과의 주소·제목·요약을 읽고 광고는 뺀다', () => {
    expect(parseDuckDuckGoHtml(FIXTURE)).toEqual({
      kind: 'results',
      results: [
        {
          url: 'https://example.org/dpr?a=1&b=2',
          title: 'Dense Passage Retrieval - 예시 블로그',
          snippet: '질문과 passage를 같은 벡터 공간에 놓는다. "밀집 검색"의 대표 모델이다.',
        },
        {
          url: 'https://example.com/watch?v=abc',
          title: 'RAG 설명 영상',
          snippet: '검색 증강 생성을 설명한다.',
        },
        { url: 'https://example.net/no-snippet', title: '요약 없는 결과', snippet: '' },
      ],
    });
  });

  it('차단 화면, 결과 없음, 모르는 모양을 구분한다', () => {
    expect(parseDuckDuckGoHtml('<div class="anomaly-modal__title">bots</div>')).toEqual({
      kind: 'blocked',
    });
    expect(parseDuckDuckGoHtml('<div class="no-results">No results found</div>')).toEqual({
      kind: 'no_results',
    });
    expect(parseDuckDuckGoHtml('<html><body>hello</body></html>')).toEqual({ kind: 'unknown' });
  });
});

describe('unwrapDuckDuckGoLink · decodeEntities', () => {
  it('감싼 주소에서 원래 주소를 꺼내고 http(s)가 아니면 버린다', () => {
    expect(
      unwrapDuckDuckGoLink('//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2Fx&amp;rut=1'),
    ).toBe('https://a.example/x');
    expect(unwrapDuckDuckGoLink('https://a.example/x?b=1&amp;c=2')).toBe(
      'https://a.example/x?b=1&c=2',
    );
    expect(unwrapDuckDuckGoLink('javascript:alert(1)')).toBe('');
    expect(unwrapDuckDuckGoLink('/relative')).toBe('');
  });

  it('숫자·이름 엔티티를 푼다', () => {
    expect(decodeEntities('a &amp; b &#44032; &#xAC00; &unknown;')).toBe('a & b 가 가 &unknown;');
  });
});

describe('duckDuckGoHtmlProvider', () => {
  it('검색 1회에 요청을 정확히 1회 보낸다', async () => {
    const http = httpOf(() => ({ status: 200, body: FIXTURE }));
    const outcome = await duckDuckGoHtmlProvider.search('  dense retrieval  ', {
      http,
      region: 'kr-kr',
    });
    expect(outcome.ok && outcome.results).toHaveLength(3);
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]).toMatchObject({
      method: 'POST',
      url: DUCKDUCKGO_HTML_ENDPOINT,
      form: { q: 'dense retrieval', kl: 'kr-kr' },
    });
    expect(duckDuckGoHtmlProvider.requestsPerSearch).toBe(1);
  });

  it('실패해도 다시 보내지 않고 종류를 구분해 돌려준다', async () => {
    const cases: [ReturnType<typeof httpOf>, string][] = [
      [httpOf(() => ({ status: 202, body: '' })), 'blocked'],
      [httpOf(() => ({ status: 429, body: '' })), 'blocked'],
      [httpOf(() => ({ status: 200, body: '<div class="anomaly-modal">x</div>' })), 'blocked'],
      [httpOf(() => ({ status: 500, body: '' })), 'http_error'],
      [httpOf(() => ({ status: 200, body: '<html></html>' })), 'parse_error'],
      [httpOf(() => new Error('getaddrinfo ENOTFOUND')), 'network'],
      [httpOf(() => Object.assign(new Error('aborted'), { name: 'TimeoutError' })), 'timeout'],
    ];
    for (const [http, kind] of cases) {
      const outcome = await duckDuckGoHtmlProvider.search('q', { http });
      expect(outcome).toMatchObject({ ok: false, kind });
      expect(http.requests).toHaveLength(1);
    }
  });

  it('빈 질의는 요청을 보내지 않는다. 결과 없음은 빈 목록이다', async () => {
    const http = httpOf(() => ({ status: 200, body: '<div class="no-results">x</div>' }));
    expect(await duckDuckGoHtmlProvider.search('  ', { http })).toMatchObject({
      ok: false,
      kind: 'empty',
    });
    expect(http.requests).toHaveLength(0);
    expect(await duckDuckGoHtmlProvider.search('q', { http })).toEqual({ ok: true, results: [] });
  });
});

describe('CandidateRegistry', () => {
  it('후보 id를 발급하고 id로만 주소를 찾는다', () => {
    const registry = new CandidateRegistry(() => NOW);
    const issued = registry.issue(
      [
        { url: 'https://a.example/1', title: ' A ', snippet: ' 글 ' },
        { url: 'ftp://a.example/2', title: 'B', snippet: '' },
        { url: 'https://a.example/1', title: '중복', snippet: '' },
        { url: 'https://a.example/3', title: 'C', snippet: '' },
      ],
      { provider: 'duckduckgo_html', query: 'q', jobId: 'job_1' },
    );
    expect(issued.map((c) => [c.candidateId, c.url, c.rank, c.title])).toEqual([
      ['cand_1', 'https://a.example/1', 1, 'A'],
      ['cand_2', 'https://a.example/3', 2, 'C'],
    ]);
    expect(registry.resolve('cand_2')?.url).toBe('https://a.example/3');
    expect(registry.resolve('https://a.example/3')).toBeUndefined();
    expect(registry.resolve('cand_9')).toBeUndefined();
  });

  it('다른 검색에서 같은 주소가 나오면 같은 id를 준다', () => {
    const registry = new CandidateRegistry(() => NOW);
    const origin = { provider: 'duckduckgo_html', jobId: 'job_1' };
    registry.issue([{ url: 'https://a.example/1', title: 'A', snippet: '' }], {
      ...origin,
      query: 'q1',
    });
    const again = registry.issue(
      [
        { url: 'https://a.example/2', title: 'B', snippet: '' },
        { url: 'https://a.example/1', title: 'A', snippet: '' },
      ],
      { ...origin, query: 'q2' },
    );
    expect(again.map((c) => c.candidateId)).toEqual(['cand_2', 'cand_1']);
    expect(registry.size).toBe(2);
  });
});
