import { describe, expect, it } from 'vitest';
import { bookmarkKey, decodeBookmarks } from './bookmark-store';

describe('책갈피 저장 데이터', () => {
  it('논문별로 분리된 저장 키를 쓴다', () => {
    expect(bookmarkKey('paper-a')).not.toBe(bookmarkKey('paper-b'));
  });
  it('처음 연 논문에는 책갈피가 없다', () => {
    expect(decodeBookmarks(null)).toEqual([]);
  });
  it('문장과 쪽을 유지하며 중복 ID는 한 번만 읽는다', () => {
    const item = { id: 's1', en: 'A sentence.', page: 2 };
    expect(decodeBookmarks(JSON.stringify([item, item]))).toEqual([item]);
  });
  it.each([
    'oops',
    '{}',
    '[null]',
    '[{"id":"s1","en":"A","page":-1}]',
    '[{"id":"s1","en":"A","page":0.5}]',
  ])('손상 데이터는 덮어쓰지 않도록 오류를 반환한다: %s', (raw) => {
    expect(() => decodeBookmarks(raw)).toThrow();
  });
});
