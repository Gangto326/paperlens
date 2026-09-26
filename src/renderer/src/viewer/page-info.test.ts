import { describe, expect, it } from 'vitest';
import { normalizeRotation, pageInfoFromProxy } from './page-info';

describe('normalizeRotation', () => {
  it('음수·360 이상·비정상 값을 0/90/180/270으로 만든다', () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(180)).toBe(180);
  });
});

describe('pageInfoFromProxy', () => {
  it('Letter 세로 페이지는 그대로', () => {
    const p = pageInfoFromProxy(0, { view: [0, 0, 612, 792], rotate: 0, userUnit: 1 });
    expect(p).toMatchObject({
      pageIndex: 0,
      pdfPageNumber: 1,
      width: 612,
      height: 792,
      rotation: 0,
    });
    expect(p.cropBox).toEqual([0, 0, 612, 792]);
    expect(p.warnings).toEqual(['mediaBox_unavailable_equals_view']);
  });

  it('90도 회전이면 표시 폭·높이가 바뀌고 원점 이동은 경고로 남는다', () => {
    const p = pageInfoFromProxy(3, { view: [10, 20, 622, 812], rotate: 90, userUnit: 1 });
    expect(p.width).toBe(792);
    expect(p.height).toBe(612);
    expect(p.rotation).toBe(90);
    expect(p.warnings).toContain('view_origin_not_zero');
  });

  it('userUnit을 크기에 반영하고 경고한다', () => {
    const p = pageInfoFromProxy(0, { view: [0, 0, 100, 200], rotate: 0, userUnit: 2 });
    expect(p.width).toBe(200);
    expect(p.height).toBe(400);
    expect(p.warnings).toContain('userUnit=2');
  });
});
