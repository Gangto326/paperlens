import { normalizeUrl, type ResearchResultEntry, type ResearchTrace } from '../research-trace';

/**
 * Codex 턴의 항목에서 검색 기록을 읽는다(0.157.1 실측, docs/search-provider-eval.md).
 *
 * `webSearch` 항목의 모양:
 * - `action`: `{type:'search', queries:[…]}` | `{type:'openPage', url}` | `{type:'findInPage', url, pattern}` | `{type:'other'}`
 * - `results[]`: `{type:'text_result', url, title, domain, snippet, ref_id}`. 생성된 프로토콜 타입에는 없는 필드다.
 *   `ref_id`가 `turn<N>view<M>`이면 열람한 쪽이고 `turn<N>search<M>`이면 검색 결과다.
 *   열람에 실패하면 제목이 "Internal Error"이고 주소가 없다.
 * 모양이 다르면 읽을 수 있는 것만 읽는다. 읽지 못한 주소는 기록에 없는 것이 되어 출처로 쓰이지 않는다.
 */
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const VIEW_REF = /view\d+$/;
const FAILED_VIEW_TITLE = 'Internal Error';

/** 조사 턴에서 나오면 안 되는 도구 항목. 보이면 그 턴의 결과를 버린다. */
export const FORBIDDEN_ITEM_TYPES: ReadonlySet<string> = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'subAgentActivity',
  'imageView',
  'imageGeneration',
  'sleep',
]);

export function researchTraceOf(items: readonly unknown[]): ResearchTrace {
  const queries: string[] = [];
  const openRequests: string[] = [];
  const byUrl = new Map<string, ResearchResultEntry>();
  let searchItems = 0;
  let failedViews = 0;

  const push = (list: string[], value: string): void => {
    if (value !== '' && !list.includes(value)) list.push(value);
  };

  for (const raw of items) {
    const item = record(raw);
    if (item?.['type'] !== 'webSearch') continue;
    searchItems += 1;
    const action = record(item['action']);
    if (action?.['type'] === 'search') {
      const many = Array.isArray(action['queries']) ? action['queries'] : [];
      for (const q of many) push(queries, text(q));
      push(queries, text(action['query']));
    } else if (action?.['type'] === 'openPage' || action?.['type'] === 'findInPage') {
      const url = text(action['url']);
      if (normalizeUrl(url) !== null) push(openRequests, url);
    }
    const results = Array.isArray(item['results']) ? item['results'] : [];
    for (const rawResult of results) {
      const result = record(rawResult);
      if (!result) continue;
      const isView = VIEW_REF.test(text(result['ref_id']));
      const url = text(result['url']);
      const key = normalizeUrl(url);
      if (key === null) {
        if (isView && text(result['title']) === FAILED_VIEW_TITLE) failedViews += 1;
        continue;
      }
      const known = byUrl.get(key);
      if (known) {
        known.viewed ||= isView;
        if (known.title === '') known.title = text(result['title']);
        continue;
      }
      const domain = text(result['domain']);
      byUrl.set(key, {
        url,
        title: text(result['title']),
        domain: domain === '' ? null : domain,
        viewed: isView,
      });
    }
  }
  return { queries, openRequests, results: [...byUrl.values()], searchItems, failedViews };
}
