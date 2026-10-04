import { describe, expect, it } from 'vitest';
import { adjacentSentenceId } from './sentence-navigation';

describe('문장 방향키 탐색', () => {
  const ids = ['s0', 's4', 's9', 's12'];
  it('ID의 숫자나 쪽 번호 대신 본문 순서를 따른다', () => {
    expect(adjacentSentenceId(ids, ['s4'], 1)).toBe('s9');
    expect(adjacentSentenceId(ids, ['s4'], -1)).toBe('s0');
  });
  it('여러 문장은 선택 범위의 앞/뒤에서 이어 읽는다', () => {
    expect(adjacentSentenceId(ids, ['s9', 's4'], 1)).toBe('s12');
    expect(adjacentSentenceId(ids, ['s9', 's4'], -1)).toBe('s0');
  });
  it('첫 문장과 마지막 문장에서 멈춘다', () => {
    expect(adjacentSentenceId(ids, ['s0'], -1)).toBeNull();
    expect(adjacentSentenceId(ids, ['s12'], 1)).toBeNull();
  });
  it('선택이 없으면 오른쪽으로 첫 문장부터 시작한다', () => {
    expect(adjacentSentenceId(ids, [], 1)).toBe('s0');
    expect(adjacentSentenceId(ids, [], -1)).toBeNull();
    expect(adjacentSentenceId([], [], 1)).toBeNull();
    expect(adjacentSentenceId(ids, ['old-document'], 1)).toBe('s0');
  });
});
