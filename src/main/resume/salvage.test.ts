import { describe, expect, it } from 'vitest';
import { salvageArrayItems } from './salvage';

const item = (n: number): Record<string, unknown> => ({
  id: `s${n}`,
  ko: `번역 ${n} "따옴표" {괄호} [대괄호] \\ 역빗금`,
  explain: '줄\n바꿈',
  conceptIds: ['c_1'],
  nested: { a: [1, { b: '}' }] },
});
const full = JSON.stringify({ kind: 'results', results: [item(1), item(2), item(3)] });

describe('salvageArrayItems', () => {
  it('끊기지 않은 출력에서는 모든 항목을 돌려준다', () => {
    expect(salvageArrayItems(full, 'results')).toEqual([item(1), item(2), item(3)]);
    expect(salvageArrayItems(JSON.stringify({ results: [] }), 'results')).toEqual([]);
  });

  it('어디에서 끊겨도 닫힌 항목만 돌려주고 지어내지 않는다', () => {
    const ends = [1, 2, 3].map((n) => full.indexOf(JSON.stringify(item(n))));
    const closes = [1, 2, 3].map((n, k) => (ends[k] ?? 0) + JSON.stringify(item(n)).length);
    for (let cut = 0; cut <= full.length; cut += 1) {
      const expected = closes.filter((c) => c <= cut).length;
      expect(salvageArrayItems(full.slice(0, cut), 'results')).toEqual(
        [item(1), item(2), item(3)].slice(0, expected),
      );
    }
  });

  it('줄바꿈과 들여쓰기가 있는 출력도 읽는다', () => {
    const pretty = JSON.stringify({ kind: 'results', results: [item(1), item(2)] }, null, 2);
    expect(salvageArrayItems(pretty.slice(0, pretty.lastIndexOf('}') - 8), 'results')).toEqual([
      item(1),
    ]);
  });

  it('이름이 같은 배열이 안쪽에 있어도 맨 바깥 객체의 것만 본다', () => {
    const text = JSON.stringify({ meta: { results: [{ id: 'inner' }] }, results: [{ id: 'a' }] });
    expect(salvageArrayItems(text, 'results')).toEqual([{ id: 'a' }]);
  });

  it('배열이 없거나 JSON이 아니면 빈 배열', () => {
    expect(salvageArrayItems('', 'results')).toEqual([]);
    expect(salvageArrayItems('Sure! Here is {"results":[{"id":"a"}]}', 'results')).toEqual([]);
    expect(salvageArrayItems('{"concepts":[{"id":"a"}]}', 'results')).toEqual([]);
    expect(salvageArrayItems('{"results":{"id":"a"}}', 'results')).toEqual([]);
    expect(salvageArrayItems('{"results":["a",{"id":"b"}]}', 'results')).toEqual([]);
  });
});
