import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  COORD_TRANSFORM_VERSION,
  textItemToUserRect,
  type Box,
  type PageBox,
} from '../geometry/coords';
import type { Rect, TextItemRecord } from '../schema/types';
import {
  CANDIDATE_SEARCH_VERSION,
  DEFAULT_RECT_MARGIN_PT,
  TextItemIndex,
  candidateStats,
  findCandidates,
  overlaps,
} from './candidates';

const letter: PageBox = { viewBox: [0, 0, 612, 792], rotation: 0, userUnit: 1 };
const pageBoxOf = (i: number): PageBox | undefined => (i === 0 || i === 1 ? letter : undefined);

/** 가로 글 항목: 기준선 (x, y), 크기 fontSize, 폭 width. */
function item(
  pageIndex: number,
  index: number,
  x: number,
  y: number,
  width: number,
  fontSize = 10,
  str = 'w',
): TextItemRecord {
  return {
    id: `t_${pageIndex}_${index}`,
    pageIndex,
    index,
    str,
    transform: [fontSize, 0, 0, fontSize, x, y],
    width,
    height: fontSize,
    fontName: 'f',
    dir: 'ltr',
    hasEOL: false,
  };
}

/** GROBID 사각형(왼쪽 위 원점). letter 페이지에서 user space y = 792 − y − h. */
const grobid = (x: number, y: number, width: number, height: number, pageIndex = 0): Rect => ({
  pageIndex,
  x,
  y,
  width,
  height,
  coordinateSpace: 'grobid_top_left_pdf_units',
  transformVersion: 'none',
});

/** user space 기준선 y=700, 높이 10인 한 줄을 덮는 GROBID 사각형: 위 y = 792 − 710 = 82. */
const line700 = (x = 100, width = 300, pageIndex = 0) => grobid(x, 82, width, 10, pageIndex);

describe('overlaps', () => {
  it('열린 구간: 모서리만 맞닿으면 겹치지 않는다', () => {
    const a: Box = { x: 0, y: 0, width: 10, height: 10 };
    expect(overlaps(a, { x: 10, y: 0, width: 5, height: 5 })).toBe(false);
    expect(overlaps(a, { x: 9.99, y: 0, width: 5, height: 5 })).toBe(true);
    expect(overlaps(a, { x: 0, y: 10, width: 5, height: 5 })).toBe(false);
  });
  it('폭 0 항목은 안쪽 점일 때만 겹친다', () => {
    const a: Box = { x: 0, y: 0, width: 10, height: 10 };
    expect(overlaps({ x: 5, y: 5, width: 0, height: 0 }, a)).toBe(true);
    expect(overlaps({ x: 10, y: 5, width: 0, height: 0 }, a)).toBe(false);
  });
});

describe('findCandidates', () => {
  const items = [
    item(0, 0, 100, 700, 50), // 줄 안
    item(0, 1, 160, 700, 50), // 줄 안
    item(0, 2, 100, 689, 50), // 아래 줄(기준선 689, 상단 699): 2pt 넓힌 사각형(698~712)에 걸친다 → 후보
    item(0, 3, 100, 660, 50), // 두 줄 아래: 안 겹침
    item(0, 4, 405, 700, 50), // 오른쪽 경계: 사각형 오른끝 400, 여유 2 → 402 < 405 안 겹침
    item(0, 5, 401, 700, 50), // 여유 안(401 < 402) → 후보
    item(1, 0, 100, 700, 50), // 다른 페이지
  ];
  const index = new TextItemIndex(items);

  it('GROBID 사각형을 user space로 옮겨 겹치는 항목을 index 순으로 돌려준다', () => {
    const r = findCandidates({ id: 's1', rects: [line700()] }, index, pageBoxOf);
    expect(r.textItemIds).toEqual(['t_0_0', 't_0_1', 't_0_2', 't_0_5']);
    expect(r.reasons).toEqual([]);
    expect(r.perRect).toHaveLength(1);
    expect(r.perRect[0]!.rect).toMatchObject({
      pageIndex: 0,
      x: 100,
      y: 700,
      width: 300,
      height: 10,
      coordinateSpace: 'pdf_user_space',
      transformVersion: COORD_TRANSFORM_VERSION,
    });
    expect(r.perRect[0]!.reason).toBeUndefined();
  });

  it('여유 0이면 경계에 걸친 항목이 빠진다', () => {
    const r = findCandidates({ id: 's1', rects: [line700()] }, index, pageBoxOf, { marginPt: 0 });
    // 아래 줄(상단 699 < 700)·오른쪽 401 > 400 은 겹치지 않는다
    expect(r.textItemIds).toEqual(['t_0_0', 't_0_1']);
  });

  it('여유가 음수·NaN이면 거부한다', () => {
    expect(() =>
      findCandidates({ id: 's', rects: [line700()] }, index, pageBoxOf, { marginPt: -1 }),
    ).toThrow(/marginPt/);
    expect(() =>
      findCandidates({ id: 's', rects: [line700()] }, index, pageBoxOf, { marginPt: NaN }),
    ).toThrow(/marginPt/);
    expect(DEFAULT_RECT_MARGIN_PT).toBeGreaterThanOrEqual(0);
  });

  it('여러 사각형·여러 페이지: 합집합을 페이지 → index 순으로, 중복 없이', () => {
    const r = findCandidates(
      { id: 's2', rects: [line700(100, 300, 1), line700(150, 20), line700(100, 300)] },
      index,
      pageBoxOf,
    );
    expect(r.textItemIds).toEqual(['t_0_0', 't_0_1', 't_0_2', 't_0_5', 't_1_0']);
    expect(r.perRect.map((p) => p.textItemIds)).toEqual([
      ['t_1_0'],
      // x 150~170을 2pt 넓히면 148~172: 오른끝 150인 t_0_0도 걸친다
      ['t_0_0', 't_0_1', 't_0_2'],
      ['t_0_0', 't_0_1', 't_0_2', 't_0_5'],
    ]);
  });

  it('이미 user space인 사각형은 변환하지 않는다', () => {
    const rect: Rect = {
      pageIndex: 0,
      x: 100,
      y: 700,
      width: 300,
      height: 10,
      coordinateSpace: 'pdf_user_space',
      transformVersion: COORD_TRANSFORM_VERSION,
    };
    const r = findCandidates({ id: 's', rects: [rect] }, index, pageBoxOf);
    expect(r.textItemIds).toEqual(['t_0_0', 't_0_1', 't_0_2', 't_0_5']);
    expect(r.perRect[0]!.rect).toBe(rect);
  });

  it('좌표 없음 → no_rects', () => {
    const r = findCandidates({ id: 's', rects: [] }, index, pageBoxOf);
    expect(r).toEqual({ sentenceId: 's', textItemIds: [], perRect: [], reasons: ['no_rects'] });
  });

  it('PageBox가 없거나 항목이 없는 페이지 → page_missing (사각형은 변환하지 않음)', () => {
    const noBox = findCandidates({ id: 's', rects: [line700(100, 300, 5)] }, index, pageBoxOf);
    expect(noBox.reasons).toEqual(['page_missing']);
    expect(noBox.perRect[0]).toEqual({
      rect: line700(100, 300, 5),
      textItemIds: [],
      reason: 'page_missing',
    });
    const emptyPage = findCandidates(
      { id: 's', rects: [line700(100, 300, 1)] },
      index,
      () => letter,
    );
    expect(emptyPage.textItemIds).toEqual(['t_1_0']);
    const noItems = findCandidates({ id: 's', rects: [line700(100, 300, 2)] }, index, () => letter);
    expect(noItems.reasons).toEqual(['page_missing']);
  });

  it('폭·높이 0 이하 또는 비유한 사각형 → rect_degenerate', () => {
    const r = findCandidates(
      {
        id: 's',
        rects: [grobid(100, 82, 0, 10), grobid(100, 82, 10, -1), grobid(NaN, 82, 10, 10)],
      },
      index,
      pageBoxOf,
    );
    expect(r.reasons).toEqual(['rect_degenerate']);
    expect(r.perRect.map((p) => p.reason)).toEqual([
      'rect_degenerate',
      'rect_degenerate',
      'rect_degenerate',
    ]);
    // 변환 전 원본을 그대로 돌려준다(음수 높이가 변환으로 뒤집혀 숨지 않는다)
    expect(r.perRect[1]!.rect).toEqual(grobid(100, 82, 10, -1));
  });

  it('겹치는 항목이 없으면 no_overlap, 다른 사각형이 후보를 내면 reasons는 비어 있다', () => {
    const far = grobid(100, 300, 300, 10);
    expect(findCandidates({ id: 's', rects: [far] }, index, pageBoxOf).reasons).toEqual([
      'no_overlap',
    ]);
    const mixed = findCandidates({ id: 's', rects: [far, line700()] }, index, pageBoxOf);
    expect(mixed.reasons).toEqual([]);
    expect(mixed.perRect[0]!.reason).toBe('no_overlap');
    expect(mixed.textItemIds).toHaveLength(4);
  });

  it('사유는 중복 없이 모인다', () => {
    const r = findCandidates(
      { id: 's', rects: [grobid(0, 0, 0, 0), grobid(0, 0, 0, 0), line700(100, 300, 7)] },
      index,
      pageBoxOf,
    );
    expect(r.reasons).toEqual(['rect_degenerate', 'page_missing']);
  });

  it('회전 페이지에서도 GROBID 사각형이 항목을 찾는다 (Rotate 90)', () => {
    // Rotate 90, letter: user (x, y) → GROBID (y − y1, x − x1) = (y, x). 항목 기준선 (100, 700) 폭 50 높이 10 →
    // user 상자 [100,700]-[150,710] → GROBID x∈[700,710], y∈[100,150].
    const rot: PageBox = { ...letter, rotation: 90 };
    const idx = new TextItemIndex([item(0, 0, 100, 700, 50)]);
    const hit = findCandidates({ id: 's', rects: [grobid(700, 100, 10, 50)] }, idx, () => rot);
    expect(hit.textItemIds).toEqual(['t_0_0']);
    const miss = findCandidates({ id: 's', rects: [grobid(100, 700, 50, 10)] }, idx, () => rot);
    expect(miss.reasons).toEqual(['no_overlap']);
  });
});

describe('TextItemIndex', () => {
  it('페이지 유무·크기', () => {
    const idx = new TextItemIndex([item(3, 0, 0, 0, 1), item(3, 1, 0, 0, 1)]);
    expect(idx.hasPage(3)).toBe(true);
    expect(idx.hasPage(0)).toBe(false);
    expect(idx.pageSize(3)).toBe(2);
    expect(idx.pageSize(0)).toBe(0);
    expect(idx.query(0, { x: 0, y: 0, width: 1, height: 1 })).toEqual([]);
  });

  it('속성: 버킷 인덱스 질의 = 전 항목 무차별 겹침 검사 (음수·큰 좌표·회전 항목 포함)', () => {
    const arbItem = (index: number) =>
      fc
        .record({
          x: fc.double({ min: -100, max: 1000, noNaN: true }),
          y: fc.double({ min: -100, max: 1000, noNaN: true }),
          width: fc.double({ min: 0, max: 200, noNaN: true }),
          size: fc.double({ min: 0, max: 40, noNaN: true }),
          angle: fc.constantFrom(0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.3),
        })
        .map(({ x, y, width, size, angle }): TextItemRecord => {
          const c = Math.cos(angle) * size;
          const s = Math.sin(angle) * size;
          return { ...item(0, index, x, y, width, size), transform: [c, s, -s, c, x, y] };
        });
    const arbItems = fc
      .array(fc.nat({ max: 300 }), { minLength: 0, maxLength: 60 })
      .chain((ns) => fc.tuple(...ns.map((_, i) => arbItem(i))));
    const arbBox = fc.record({
      x: fc.double({ min: -100, max: 1000, noNaN: true }),
      y: fc.double({ min: -100, max: 1000, noNaN: true }),
      width: fc.double({ min: 0, max: 300, noNaN: true }),
      height: fc.double({ min: 0, max: 100, noNaN: true }),
    });
    fc.assert(
      fc.property(arbItems, arbBox, (items, box) => {
        const idx = new TextItemIndex(items);
        const got = idx.query(0, box).map((i) => i.id);
        const want = items.filter((i) => overlaps(textItemToUserRect(i), box)).map((i) => i.id);
        expect(got).toEqual(want);
      }),
      { numRuns: Number(process.env['FC_NUM_RUNS'] ?? 300) },
    );
  });
});

describe('candidateStats', () => {
  it('분포와 사유 집계', () => {
    const st = candidateStats([
      { sentenceId: 'a', textItemIds: ['1', '2', '3'], perRect: [], reasons: [] },
      { sentenceId: 'b', textItemIds: ['1'], perRect: [], reasons: [] },
      { sentenceId: 'c', textItemIds: [], perRect: [], reasons: ['no_rects'] },
      { sentenceId: 'd', textItemIds: [], perRect: [], reasons: ['page_missing', 'no_overlap'] },
      { sentenceId: 'e', textItemIds: ['1', '2', '3', '4', '5', '6'], perRect: [], reasons: [] },
    ]);
    expect(st).toEqual({
      sentences: 5,
      withCandidates: 3,
      zero: 2,
      zeroByReason: { no_rects: 1, page_missing: 1, rect_degenerate: 0, no_overlap: 1 },
      min: 1,
      median: 3,
      max: 6,
      mean: 10 / 3,
    });
  });
  it('빈 입력', () => {
    expect(candidateStats([])).toMatchObject({
      sentences: 0,
      withCandidates: 0,
      zero: 0,
      min: 0,
      median: 0,
      max: 0,
      mean: 0,
    });
  });
  it('버전 상수는 비어 있지 않다', () => {
    expect(CANDIDATE_SEARCH_VERSION).toMatch(/^\d+$/);
  });
});
