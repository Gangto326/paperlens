/**
 * 조사 턴의 검색 기록(PLAN 3.3.1, COMMIT_PLAN R4.2). 어댑터 중립 타입이다.
 * 앱은 모델이 돌려준 출처를 이 기록과 대조한다. 기록에 없는 주소는 저장하지 않는다.
 */
export interface ResearchResultEntry {
  url: string;
  title: string;
  domain: string | null;
  /** 런타임이 열람한 결과로 표시했는지. 검색 결과 목록에만 나온 것은 false다. */
  viewed: boolean;
}

export interface ResearchTrace {
  /** 모델이 보낸 검색어. 보낸 순서, 중복 없음 */
  queries: string[];
  /** 모델이 열려고 한 주소. 열람에 실패한 것도 들어 있다 */
  openRequests: string[];
  /** 검색 결과와 열람 결과에 나온 주소. 주소마다 하나 */
  results: ResearchResultEntry[];
  /** 검색 도구 항목 수 */
  searchItems: number;
  /** 열람이 실패로 표시된 횟수 */
  failedViews: number;
}

export const EMPTY_RESEARCH_TRACE: ResearchTrace = {
  queries: [],
  openRequests: [],
  results: [],
  searchItems: 0,
  failedViews: 0,
};

/** 주소 비교용 모양. 조각(#…)과 끝의 빗금을 떼고 호스트를 소문자로 한다. http(s)가 아니면 null. */
export function normalizeUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    const text = parsed.toString();
    return text.endsWith('/') ? text.slice(0, -1) : text;
  } catch {
    return null;
  }
}

export type SourceStanding = 'viewed' | 'listed' | 'absent';

/** 주소가 기록에서 어떤 위치인지. viewed는 열람 기록이 있고, listed는 검색 결과에만 나왔다. */
export function standingOf(trace: ResearchTrace, url: string): SourceStanding {
  const key = normalizeUrl(url);
  if (key === null) return 'absent';
  let listed = false;
  for (const entry of trace.results) {
    if (normalizeUrl(entry.url) !== key) continue;
    if (entry.viewed) return 'viewed';
    listed = true;
  }
  return listed ? 'listed' : 'absent';
}
