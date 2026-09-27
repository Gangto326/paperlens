import { describe, expect, it } from 'vitest';
import {
  compareSpans,
  isKeyChar,
  itemsDigest,
  keyOffsets,
  keyPositions,
  outcomeOf,
  parseSpans,
  textSha,
} from './truth';

const items = new Map([
  ['t_0_0', 'Retrie-'],
  ['t_0_1', 'val (RAG) ﬁne, 𝑥=1.'],
]);
const strOf = (id: string) => items.get(id);

describe('정답 스팬 해석', () => {
  it('항목 id와 utf16 범위를 읽는다', () => {
    expect(parseSpans('t_0_0:0-6 t_12_3:4-10')).toEqual([
      { textItemId: 't_0_0', start: 0, end: 6 },
      { textItemId: 't_12_3', start: 4, end: 10 },
    ]);
    expect(parseSpans(undefined)).toEqual([]);
    expect(parseSpans('')).toEqual([]);
  });

  it('형식이 틀리거나 빈 범위면 던진다', () => {
    expect(() => parseSpans('t_0_0:0')).toThrow(/형식/);
    expect(() => parseSpans('x_0_0:0-3')).toThrow(/형식/);
    expect(() => parseSpans('t_0_0:3-3')).toThrow(/범위/);
  });
});

describe('비교 대상 글자', () => {
  it('문자·숫자만 센다. 합자와 수학 글자는 풀어서 본다', () => {
    expect(isKeyChar('a')).toBe(true);
    expect(isKeyChar('7')).toBe(true);
    expect(isKeyChar('ﬁ')).toBe(true);
    expect(isKeyChar('𝑥')).toBe(true);
    expect(isKeyChar('é')).toBe(true);
    expect(isKeyChar('-')).toBe(false);
    expect(isKeyChar(' ')).toBe(false);
    expect(isKeyChar('(')).toBe(false);
    expect(isKeyChar('=')).toBe(false);
  });

  it('범위 안 글자 위치를 utf16 offset으로 모은다(보충 평면 글자는 2칸)', () => {
    const all = keyOffsets(parseSpans('t_0_0:0-7 t_0_1:0-19'), strOf);
    expect(all.has('t_0_0:5')).toBe(true);
    expect(all.has('t_0_0:6')).toBe(false); // 하이픈
    expect(all.has('t_0_1:10')).toBe(true); // ﬁ
    // '𝑥'는 offset 15에서 시작해 2칸을 쓴다. 뒤의 '1'은 18.
    expect(all.has('t_0_1:15')).toBe(true);
    expect(all.has('t_0_1:16')).toBe(false);
    expect(all.has('t_0_1:18')).toBe(true);
    expect(keyOffsets(parseSpans('t_0_1:0-3'), strOf)).toEqual(
      new Set(['t_0_1:0', 't_0_1:1', 't_0_1:2']),
    );
  });

  it('없는 항목은 건너뛴다', () => {
    expect(keyOffsets(parseSpans('t_9_9:0-3'), strOf).size).toBe(0);
  });

  it('선택 흉내용 위치는 순서를 지킨다', () => {
    const pos = keyPositions(parseSpans('t_0_0:4-7 t_0_1:0-3'), strOf);
    expect(pos.map((p) => `${p.textItemId}:${p.offset}`)).toEqual([
      't_0_0:4',
      't_0_0:5',
      't_0_1:0',
      't_0_1:1',
      't_0_1:2',
    ]);
  });
});

describe('스팬 비교', () => {
  const truth = new Set(['a:0', 'a:1', 'a:2']);
  const none = new Set<string>();

  it('구두점 차이는 집합에 없으므로 같은 글자면 equal', () => {
    expect(compareSpans(truth, none, new Set(['a:0', 'a:1', 'a:2']))).toEqual({
      verdict: 'equal',
      truth: 3,
      missing: 0,
      extra: 0,
    });
  });

  it('빠짐·넘침·둘 다·스팬 없음을 가른다', () => {
    expect(compareSpans(truth, none, new Set(['a:0', 'a:1'])).verdict).toBe('missing');
    expect(compareSpans(truth, none, new Set(['a:0', 'a:1', 'a:2', 'b:0'])).verdict).toBe('extra');
    expect(compareSpans(truth, none, new Set(['a:0', 'b:0'])).verdict).toBe('both');
    expect(compareSpans(truth, none, none).verdict).toBe('no_spans');
  });

  it('optional 글자는 있어도 없어도 같다', () => {
    const optional = new Set(['n:0']);
    expect(compareSpans(truth, optional, new Set(['a:0', 'a:1', 'a:2', 'n:0'])).verdict).toBe(
      'equal',
    );
    expect(compareSpans(truth, optional, new Set(['a:0', 'a:1', 'a:2'])).verdict).toBe('equal');
  });

  it('mapped인데 다르면 조용한 오매핑, 표시가 있으면 flagged', () => {
    expect(outcomeOf('mapped', 'equal')).toBe('correct');
    expect(outcomeOf('uncertain', 'equal')).toBe('correct');
    expect(outcomeOf('mapped', 'missing')).toBe('silent');
    expect(outcomeOf('mapped', 'extra')).toBe('silent');
    expect(outcomeOf('uncertain', 'both')).toBe('flagged');
    expect(outcomeOf('unmapped', 'no_spans')).toBe('flagged');
  });
});

describe('지문', () => {
  it('문장 글과 항목 목록이 바뀌면 값이 달라진다', () => {
    expect(textSha('abc')).toBe('ba7816bf8f01cfea');
    expect(textSha('abd')).not.toBe(textSha('abc'));
    const a = itemsDigest([{ id: 't_0_0', str: 'x' }]);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(itemsDigest([{ id: 't_0_0', str: 'y' }])).not.toBe(a);
    expect(itemsDigest([{ id: 't_0_1', str: 'x' }])).not.toBe(a);
  });
});
