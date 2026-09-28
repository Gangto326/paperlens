import { sha256Hex } from '../cache/hash';

/**
 * 검색 제공자 계약과 후보 발급(COMMIT_PLAN C4.2, 0.3-3).
 *
 * - 제공자는 HTTP를 직접 하지 않는다. 호출자가 준 `http` 함수만 쓴다. 외부 요청이 모두 같은 관문을
 *   지나게 하려는 것이다(PLAN 3.3 항목 6). 제공자는 검색 1회에 `http`를 정확히 `requestsPerSearch`번 부른다.
 *   내부 재시도와 엔진 전환을 하지 않는다.
 * - 검색 결과의 URL은 모델에 그대로 주지 않고 `candidateId`로 발급한다. 읽기 도구는 이 id만 받는다.
 *   모델이 기억으로 쓴 URL을 읽게 할 길이 없다.
 */
export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  /** POST의 form 본문 */
  form?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  body: string;
}

export type HttpFunction = (request: HttpRequest) => Promise<HttpResponse>;

export interface RawSearchResult {
  url: string;
  title: string;
  snippet: string;
}

export type SearchFailureKind =
  'blocked' | 'http_error' | 'network' | 'timeout' | 'parse_error' | 'empty';

export type SearchOutcome =
  | { ok: true; results: RawSearchResult[] }
  | { ok: false; kind: SearchFailureKind; message: string };

export interface SearchOptions {
  http: HttpFunction;
  /** 결과 언어·지역. 제공자가 아는 값만 쓴다. 예: 'kr-kr' */
  region?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SearchProvider {
  readonly name: string;
  /** 검색 1회에 보내는 외부 요청 수. 예산 장부가 이만큼 예약한다. */
  readonly requestsPerSearch: number;
  search(query: string, options: SearchOptions): Promise<SearchOutcome>;
}

export interface SearchCandidate {
  candidateId: string;
  url: string;
  title: string;
  snippet: string;
  /** 검색 결과 안의 순위. 1부터 */
  rank: number;
  provider: string;
  queryHash: string;
  jobId: string;
  discoveredAt: string;
}

const isHttpUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * 후보 장부. 같은 URL은 같은 id를 다시 준다. http(s)가 아닌 URL은 후보로 만들지 않는다.
 * 사설망·리다이렉트 검사는 읽기 관문(C4.3)이 요청 직전에 한다.
 */
export class CandidateRegistry {
  private readonly byId = new Map<string, SearchCandidate>();
  private readonly idByUrl = new Map<string, string>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  issue(
    results: readonly RawSearchResult[],
    origin: { provider: string; query: string; jobId: string },
  ): SearchCandidate[] {
    const issued: SearchCandidate[] = [];
    const seen = new Set<string>();
    let rank = 0;
    for (const result of results) {
      const url = result.url.trim();
      if (!isHttpUrl(url) || seen.has(url)) continue;
      seen.add(url);
      rank += 1;
      const known = this.idByUrl.get(url);
      const existing = known === undefined ? undefined : this.byId.get(known);
      if (existing) {
        issued.push({ ...existing });
        continue;
      }
      const candidate: SearchCandidate = {
        candidateId: `cand_${this.byId.size + 1}`,
        url,
        title: result.title.trim(),
        snippet: result.snippet.trim(),
        rank,
        provider: origin.provider,
        queryHash: sha256Hex(origin.query),
        jobId: origin.jobId,
        discoveredAt: this.now().toISOString(),
      };
      this.byId.set(candidate.candidateId, candidate);
      this.idByUrl.set(url, candidate.candidateId);
      issued.push({ ...candidate });
    }
    return issued;
  }

  resolve(candidateId: string): SearchCandidate | undefined {
    const found = this.byId.get(candidateId.trim());
    return found ? { ...found } : undefined;
  }

  get size(): number {
    return this.byId.size;
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const textOf = (html: string): string =>
  decodeEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();

/** DuckDuckGo가 결과 링크를 자기 주소로 감싼 경우(`/l/?uddg=<원래 주소>`) 원래 주소를 꺼낸다. */
export function unwrapDuckDuckGoLink(href: string): string {
  const raw = decodeEntities(href.trim());
  const absolute = raw.startsWith('//') ? `https:${raw}` : raw;
  try {
    const parsed = new URL(absolute, 'https://duckduckgo.com');
    if (parsed.hostname.endsWith('duckduckgo.com') && parsed.pathname === '/l/') {
      return parsed.searchParams.get('uddg') ?? absolute;
    }
    return /^https?:/i.test(absolute) ? absolute : '';
  } catch {
    return '';
  }
}

export type DuckDuckGoPage =
  | { kind: 'results'; results: RawSearchResult[] }
  | { kind: 'blocked' }
  | { kind: 'no_results' }
  | { kind: 'unknown' };

/** html.duckduckgo.com 결과 쪽을 읽는다. 광고 블록은 뺀다. */
export function parseDuckDuckGoHtml(html: string): DuckDuckGoPage {
  if (/anomaly-modal|challenge-form|class="anomaly/i.test(html)) return { kind: 'blocked' };
  const results: RawSearchResult[] = [];
  const openings = [...html.matchAll(/<div[^>]*class="(result results_links[^"]*)"[^>]*>/gi)];
  for (const [i, opening] of openings.entries()) {
    if (/result--ad/i.test(opening[1] ?? '')) continue;
    const start = opening.index + opening[0].length;
    const block = html.slice(start, openings[i + 1]?.index ?? html.length);
    const link = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a\s*>/i.exec(block);
    if (!link) continue;
    const url = unwrapDuckDuckGoLink(link[1] ?? '');
    if (url === '' || /duckduckgo\.com\/y\.js/i.test(url)) continue;
    const snippet = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a\s*>/i.exec(block);
    results.push({ url, title: textOf(link[2] ?? ''), snippet: textOf(snippet?.[1] ?? '') });
  }
  if (results.length > 0) return { kind: 'results', results };
  if (/class="no-results"|No results found|결과가 없습니다/i.test(html)) {
    return { kind: 'no_results' };
  }
  return { kind: 'unknown' };
}

export const DUCKDUCKGO_HTML_ENDPOINT = 'https://html.duckduckgo.com/html/';
const DEFAULT_TIMEOUT_MS = 15_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

/**
 * 키 없는 검색 제공자. 검색 1회에 요청 1회다. 실패해도 다시 보내지 않는다.
 * 결과 품질과 차단율은 보장하지 않는다(PLAN 3.4). 평가는 search-eval.live.test.ts로 한다.
 */
export const duckDuckGoHtmlProvider: SearchProvider = {
  name: 'duckduckgo_html',
  requestsPerSearch: 1,
  async search(query, options) {
    const q = query.trim();
    if (q === '') return { ok: false, kind: 'empty', message: '질의가 비어 있습니다' };
    const form: Record<string, string> = { q };
    if (options.region) form['kl'] = options.region;
    let response: HttpResponse;
    try {
      response = await options.http({
        method: 'POST',
        url: DUCKDUCKGO_HTML_ENDPOINT,
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
        form,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const timeout = err instanceof Error && /abort|timeout/i.test(`${err.name} ${message}`);
      return { ok: false, kind: timeout ? 'timeout' : 'network', message };
    }
    if (response.status === 202 || response.status === 403 || response.status === 429) {
      return { ok: false, kind: 'blocked', message: `HTTP ${response.status}` };
    }
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, kind: 'http_error', message: `HTTP ${response.status}` };
    }
    const page = parseDuckDuckGoHtml(response.body);
    if (page.kind === 'results') return { ok: true, results: page.results };
    if (page.kind === 'blocked') {
      return { ok: false, kind: 'blocked', message: '차단 화면을 받았습니다' };
    }
    if (page.kind === 'no_results') return { ok: true, results: [] };
    return { ok: false, kind: 'parse_error', message: '결과 쪽의 모양을 알 수 없습니다' };
  },
};

/** Node의 fetch로 만든 `http`. 리다이렉트를 따르지 않는다. 읽기 관문(C4.3)이 생기면 그쪽 것으로 바꾼다. */
export const plainHttp: HttpFunction = async (request) => {
  const timeout = AbortSignal.timeout(request.timeoutMs);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  const init: RequestInit = {
    method: request.method,
    headers: request.form
      ? { ...request.headers, 'Content-Type': 'application/x-www-form-urlencoded' }
      : request.headers,
    redirect: 'manual',
    signal,
  };
  if (request.form) init.body = new URLSearchParams(request.form).toString();
  const response = await fetch(request.url, init);
  return { status: response.status, body: await response.text() };
};
