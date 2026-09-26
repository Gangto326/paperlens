import { describe, expect, it } from 'vitest';
import { pageIndicesOf, parseGrobidCoords } from './tei-coords';

describe('parseGrobidCoords', () => {
  it('세미콜론으로 나뉜 조각을 0-based pageIndex Rect로 바꾼다', () => {
    const { rects, warnings } = parseGrobidCoords(
      '1,143.87,344.43,324.26,8.64;1,143.87,355.34,325.92,8.64;2,10,20,30,40',
    );
    expect(warnings).toEqual([]);
    expect(rects).toHaveLength(3);
    expect(rects[0]).toEqual({
      pageIndex: 0,
      x: 143.87,
      y: 344.43,
      width: 324.26,
      height: 8.64,
      coordinateSpace: 'grobid_top_left_pdf_units',
      transformVersion: 'none',
    });
    expect(rects[2]?.pageIndex).toBe(1);
    expect(pageIndicesOf(rects)).toEqual([0, 1]);
  });

  it('빈 문자열·undefined는 coords_missing 경고와 빈 목록', () => {
    expect(parseGrobidCoords('')).toEqual({ rects: [], warnings: ['coords_missing'] });
    expect(parseGrobidCoords(undefined)).toEqual({ rects: [], warnings: ['coords_missing'] });
  });

  it('깨진 조각은 건너뛰고 경고를 남긴다', () => {
    const { rects, warnings } = parseGrobidCoords('1,1,2,3,4;abc;0,1,2,3,4;1,1,2,3');
    expect(rects).toHaveLength(1);
    expect(warnings).toEqual([
      'coords_malformed:abc',
      'coords_page_invalid:0',
      'coords_malformed:1,1,2,3',
    ]);
  });
});
