import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Rect } from '../schema/types';
import {
  COORD_TRANSFORM_VERSION,
  applyMatrix,
  grobidMatrix,
  grobidToUserSpace,
  invertMatrix,
  normalizeRotation,
  pageBoxOf,
  textItemToUserRect,
  userSpaceToGrobid,
  userSpaceToViewport,
  viewportMatrix,
  viewportSize,
  viewportToUserSpace,
  type PageBox,
} from './coords';

const letter: PageBox = { viewBox: [0, 0, 612, 792], rotation: 0, userUnit: 1 };
const cropped: PageBox = { viewBox: [40, 50, 560, 740], rotation: 0, userUnit: 1 };

const grobid = (x: number, y: number, width: number, height: number, pageIndex = 0): Rect => ({
  pageIndex,
  x,
  y,
  width,
  height,
  coordinateSpace: 'grobid_top_left_pdf_units',
  transformVersion: 'none',
});
const user = (x: number, y: number, width: number, height: number, pageIndex = 0): Rect => ({
  pageIndex,
  x,
  y,
  width,
  height,
  coordinateSpace: 'pdf_user_space',
  transformVersion: COORD_TRANSFORM_VERSION,
});

const close = (a: Rect | { x: number; y: number; width: number; height: number }, b: typeof a) => {
  expect(a.x).toBeCloseTo(b.x, 9);
  expect(a.y).toBeCloseTo(b.y, 9);
  expect(a.width).toBeCloseTo(b.width, 9);
  expect(a.height).toBeCloseTo(b.height, 9);
};

describe('normalizeRotation', () => {
  it('음수·360 이상·비정상 값을 0/90/180/270으로 만든다', () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(180)).toBe(180);
    expect(normalizeRotation(100)).toBe(90);
  });
});

describe('viewportMatrix', () => {
  it('회전 0: y만 뒤집고 viewBox 원점을 왼쪽 위로 옮긴다', () => {
    expect(applyMatrix(viewportMatrix(letter, 1), 0, 792)).toEqual([0, 0]);
    expect(applyMatrix(viewportMatrix(letter, 1), 612, 0)).toEqual([612, 792]);
    expect(applyMatrix(viewportMatrix(cropped, 1), 40, 740)).toEqual([0, 0]);
    expect(applyMatrix(viewportMatrix(cropped, 2), 560, 50)).toEqual([1040, 1380]);
  });

  it('회전 90: user space 왼쪽 아래가 뷰포트 왼쪽 위로 간다', () => {
    const m = viewportMatrix({ ...cropped, rotation: 90 }, 1);
    expect(applyMatrix(m, 40, 50)).toEqual([0, 0]);
    expect(applyMatrix(m, 40, 740)).toEqual([690, 0]);
    expect(viewportSize({ ...cropped, rotation: 90 }, 1)).toEqual({ width: 690, height: 520 });
  });

  it('회전 180·270도 viewBox 모서리가 뷰포트 모서리로 간다', () => {
    const m180 = viewportMatrix({ ...cropped, rotation: 180 }, 1);
    expect(applyMatrix(m180, 560, 50)).toEqual([0, 0]);
    const m270 = viewportMatrix({ ...cropped, rotation: 270 }, 1);
    expect(applyMatrix(m270, 560, 740)).toEqual([0, 0]);
  });

  it('userUnit은 scale에 곱해진다', () => {
    const m = viewportMatrix({ ...letter, userUnit: 2 }, 1.5);
    expect(applyMatrix(m, 612, 0)).toEqual([612 * 3, 792 * 3]);
  });

  it('pageBoxOf는 Page의 cropBox·rotation·userUnit만 쓴다', () => {
    expect(
      pageBoxOf({
        pageIndex: 0,
        pdfPageNumber: 1,
        width: 792,
        height: 612,
        rotation: 90,
        userUnit: 1,
        mediaBox: [0, 0, 612, 792],
        cropBox: [40, 50, 560, 740],
        coordinateSpace: 'pdf_user_space',
        textQuality: 'ok',
        warnings: [],
      }),
    ).toEqual({ viewBox: [40, 50, 560, 740], rotation: 90, userUnit: 1 });
  });
});

describe('invertMatrix', () => {
  it('역행렬을 곱하면 원점으로 돌아온다', () => {
    const m = viewportMatrix({ ...cropped, rotation: 90 }, 1.75);
    const inv = invertMatrix(m);
    const [x, y] = applyMatrix(m, 123.4, 567.8);
    const back = applyMatrix(inv, x, y);
    expect(back[0]).toBeCloseTo(123.4, 9);
    expect(back[1]).toBeCloseTo(567.8, 9);
  });

  it('특이 행렬은 거부한다', () => {
    expect(() => invertMatrix([0, 0, 0, 0, 1, 1])).toThrow('not invertible');
  });
});

describe('grobidToUserSpace / userSpaceToGrobid', () => {
  it('GROBID 공간은 회전 반영·userUnit 미반영 scale 1 뷰포트다', () => {
    expect(grobidMatrix({ ...cropped, rotation: 90, userUnit: 3 })).toEqual(
      viewportMatrix({ ...cropped, rotation: 90, userUnit: 1 }, 1),
    );
  });

  it('Letter 세로: y를 뒤집는다', () => {
    const u = grobidToUserSpace(grobid(100, 50, 200, 20, 3), letter);
    expect(u).toEqual(user(100, 722, 200, 20, 3));
    expect(userSpaceToGrobid(u, letter)).toEqual({
      ...grobid(100, 50, 200, 20, 3),
      transformVersion: COORD_TRANSFORM_VERSION,
    });
  });

  it('CropBox 오프셋: GROBID 원점이 CropBox 왼쪽 위다', () => {
    close(grobidToUserSpace(grobid(0, 0, 10, 10), cropped), user(40, 730, 10, 10));
  });

  it('회전 90: GROBID 원점이 user space 왼쪽 아래이고 폭·높이가 바뀐다', () => {
    close(
      grobidToUserSpace(grobid(0, 0, 30, 10), { ...cropped, rotation: 90 }),
      user(40, 50, 10, 30),
    );
  });

  it('좌표 공간이 어긋난 입력은 거부한다', () => {
    expect(() => grobidToUserSpace(user(0, 0, 1, 1), letter)).toThrow('expected');
    expect(() => userSpaceToGrobid(grobid(0, 0, 1, 1), letter)).toThrow('expected');
  });
});

describe('userSpaceToViewport / viewportToUserSpace', () => {
  it('scale과 사용자 회전을 반영한다', () => {
    const vp = userSpaceToViewport(user(40, 730, 10, 20), cropped, 2, 90);
    close(vp, { x: 1360, y: 0, width: 40, height: 20 });
    close(viewportToUserSpace(vp, 0, cropped, 2, 90), user(40, 730, 10, 20));
  });
});

describe('textItemToUserRect', () => {
  it('가로 글은 기준선에서 위로 height만큼', () => {
    const r = textItemToUserRect({
      pageIndex: 2,
      transform: [10, 0, 0, 10, 100, 700],
      width: 50,
      height: 10,
    });
    expect(r).toEqual(user(100, 700, 50, 10, 2));
  });

  it('90도 돌아간 글은 폭·높이를 바꿔 경계 상자로 만든다', () => {
    const r = textItemToUserRect({
      pageIndex: 0,
      transform: [0, 10, -10, 0, 100, 700],
      width: 50,
      height: 10,
    });
    close(r, user(90, 700, 10, 50));
  });

  it('퇴화한 transform은 (e, f)에 놓인 상자로 처리한다', () => {
    const r = textItemToUserRect({
      pageIndex: 0,
      transform: [0, 0, 0, 0, 5, 6],
      width: 3,
      height: 4,
    });
    close(r, user(5, 6, 3, 4));
  });
});

describe('왕복 속성', () => {
  const box = fc
    .record({
      x1: fc.double({ min: -100, max: 100, noNaN: true }),
      y1: fc.double({ min: -100, max: 100, noNaN: true }),
      w: fc.double({ min: 1, max: 2000, noNaN: true }),
      h: fc.double({ min: 1, max: 2000, noNaN: true }),
      rotation: fc.constantFrom(0, 90, 180, 270),
      userUnit: fc.double({ min: 0.1, max: 10, noNaN: true }),
    })
    .map(({ x1, y1, w, h, rotation, userUnit }): PageBox => ({
      viewBox: [x1, y1, x1 + w, y1 + h],
      rotation,
      userUnit,
    }));
  const rectIn = (b: PageBox) =>
    fc
      .record({
        fx: fc.double({ min: 0, max: 1, noNaN: true }),
        fy: fc.double({ min: 0, max: 1, noNaN: true }),
        fw: fc.double({ min: 0, max: 1, noNaN: true }),
        fh: fc.double({ min: 0, max: 1, noNaN: true }),
      })
      .map(({ fx, fy, fw, fh }) => {
        // 페이지 안에 완전히 들어가는 사각형만 만든다.
        const [x1, y1, x2, y2] = b.viewBox;
        const w = x2 - x1;
        const h = y2 - y1;
        return user(x1 + fx * w, y1 + fy * h, fw * (1 - fx) * w, fh * (1 - fy) * h);
      });
  const numRuns = Number(process.env['FC_NUM_RUNS'] ?? 200);

  it('user → GROBID → user 오차 < 0.5pt(실제로는 1e-6 이하)', () => {
    fc.assert(
      fc.property(
        box.chain((b) => fc.tuple(fc.constant(b), rectIn(b))),
        ([b, r]) => {
          const back = grobidToUserSpace(userSpaceToGrobid(r, b), b);
          for (const k of ['x', 'y', 'width', 'height'] as const) {
            if (Math.abs(back[k] - r[k]) > 1e-6) return false;
          }
          return back.transformVersion === COORD_TRANSFORM_VERSION;
        },
      ),
      { numRuns },
    );
  });

  it('user → 뷰포트 → user 오차 < 1e-6 (scale·사용자 회전 임의)', () => {
    fc.assert(
      fc.property(
        box.chain((b) => fc.tuple(fc.constant(b), rectIn(b))),
        fc.double({ min: 0.25, max: 8, noNaN: true }),
        fc.constantFrom(0, 90, 180, 270),
        ([b, r], scale, rot) => {
          const back = viewportToUserSpace(userSpaceToViewport(r, b, scale, rot), 0, b, scale, rot);
          return (['x', 'y', 'width', 'height'] as const).every(
            (k) => Math.abs(back[k] - r[k]) <= 1e-6,
          );
        },
      ),
      { numRuns },
    );
  });

  it('GROBID 상자는 항상 표시 페이지 안에 있다(뷰포트 크기 기준)', () => {
    fc.assert(
      fc.property(
        box.chain((b) => fc.tuple(fc.constant(b), rectIn(b))),
        ([b, r]) => {
          const g = userSpaceToGrobid(r, b);
          const size = viewportSize({ ...b, userUnit: 1 }, 1);
          return (
            g.x >= -1e-6 &&
            g.y >= -1e-6 &&
            g.x + g.width <= size.width + 1e-6 &&
            g.y + g.height <= size.height + 1e-6
          );
        },
      ),
      { numRuns },
    );
  });
});
