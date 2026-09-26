import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { buildMinimalPdf } from './__fixtures__/minimal-pdf';
import {
  grobidToUserSpace,
  textItemToUserRect,
  userSpaceToGrobid,
  userSpaceToViewport,
  viewportMatrix,
  viewportSize,
  type PageBox,
} from './coords';

/**
 * 합성 PDF(MediaBox ≠ CropBox, 회전 0/90/180/270)를 실제 PDF.js로 열어
 * - view가 CropBox와 같은지, 텍스트 항목 transform이 회전·CropBox와 무관한 user space인지
 * - viewportMatrix가 getViewport().transform과 같은지
 * - user → GROBID → user 왕복 오차 < 0.5pt인지 확인한다.
 */
const MEDIA = [0, 0, 612, 792] as const;
const CROP = [40, 50, 560, 740] as const;

async function openPage(rotate: number, userUnit?: number) {
  const data = buildMinimalPdf({
    mediaBox: MEDIA,
    cropBox: CROP,
    rotate,
    ...(userUnit !== undefined ? { userUnit } : {}),
    at: [100, 600],
  });
  const task = getDocument({ data, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const box: PageBox = {
    viewBox: page.view as [number, number, number, number],
    rotation: page.rotate,
    userUnit: page.userUnit,
  };
  return { task, page, box };
}

describe.each([0, 90, 180, 270])('회전 %d + CropBox', (rotate) => {
  it('view = CropBox, 텍스트 항목 transform은 user space 그대로', async () => {
    const { task, page, box } = await openPage(rotate);
    expect(box.viewBox).toEqual([...CROP]);
    expect(box.rotation).toBe(rotate);
    const content = await page.getTextContent();
    const items = content.items.filter((i) => 'str' in i);
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.transform[4]).toBeCloseTo(100, 6);
    expect(item.transform[5]).toBeCloseTo(600, 6);
    await task.destroy();
  });

  it.each([1, 1.5])(
    'viewportMatrix(scale=%s)가 PDF.js getViewport().transform과 같다',
    async (scale) => {
      const { task, page, box } = await openPage(rotate);
      const vp = page.getViewport({ scale });
      const m = viewportMatrix(box, scale);
      for (let i = 0; i < 6; i++) expect(m[i]).toBeCloseTo(vp.transform[i]!, 9);
      expect(viewportSize(box, scale)).toEqual({ width: vp.width, height: vp.height });
      // 사용자 회전(페이지 회전 + 90)도 같다
      const vp2 = page.getViewport({ scale, rotation: rotate + 90 });
      const m2 = viewportMatrix(box, scale, rotate + 90);
      for (let i = 0; i < 6; i++) expect(m2[i]).toBeCloseTo(vp2.transform[i]!, 9);
      await task.destroy();
    },
  );

  it('텍스트 항목 상자의 뷰포트 변환이 convertToViewportPoint와 같고 왕복 오차 < 0.5pt', async () => {
    const { task, page, box } = await openPage(rotate);
    const content = await page.getTextContent();
    const item = content.items.find((i) => 'str' in i)!;
    const rect = textItemToUserRect({
      pageIndex: 0,
      transform: item.transform as [number, number, number, number, number, number],
      width: item.width,
      height: item.height,
    });
    expect(rect.x).toBeCloseTo(100, 6);
    expect(rect.y).toBeCloseTo(600, 6);
    expect(rect.width).toBeGreaterThan(0);

    const vp = page.getViewport({ scale: 2 });
    const [ax, ay] = vp.convertToViewportPoint(rect.x, rect.y) as [number, number];
    const [bx, by] = vp.convertToViewportPoint(rect.x + rect.width, rect.y + rect.height) as [
      number,
      number,
    ];
    const mine = userSpaceToViewport(rect, box, 2);
    expect(mine.x).toBeCloseTo(Math.min(ax, bx), 9);
    expect(mine.y).toBeCloseTo(Math.min(ay, by), 9);
    expect(mine.width).toBeCloseTo(Math.abs(bx - ax), 9);
    expect(mine.height).toBeCloseTo(Math.abs(by - ay), 9);

    const g = userSpaceToGrobid(rect, box);
    const size = viewportSize({ ...box, userUnit: 1 }, 1);
    expect(g.x).toBeGreaterThanOrEqual(0);
    expect(g.y).toBeGreaterThanOrEqual(0);
    expect(g.x + g.width).toBeLessThanOrEqual(size.width);
    expect(g.y + g.height).toBeLessThanOrEqual(size.height);
    const back = grobidToUserSpace(g, box);
    for (const k of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(back[k] - rect[k])).toBeLessThan(0.5);
    }
    await task.destroy();
  });
});

describe('UserUnit', () => {
  it('PDF.js는 userUnit을 뷰포트 scale에 곱하고, GROBID 공간은 곱하지 않는다', async () => {
    const { task, page, box } = await openPage(0, 2);
    expect(box.userUnit).toBe(2);
    const vp = page.getViewport({ scale: 1 });
    expect(vp.width).toBe(520 * 2);
    expect(viewportSize(box, 1)).toEqual({ width: vp.width, height: vp.height });
    const g = userSpaceToGrobid(
      {
        pageIndex: 0,
        x: 40,
        y: 730,
        width: 10,
        height: 10,
        coordinateSpace: 'pdf_user_space',
        transformVersion: '1',
      },
      box,
    );
    expect(g.x).toBeCloseTo(0, 9);
    expect(g.y).toBeCloseTo(0, 9);
    expect(g.width).toBeCloseTo(10, 9);
    await task.destroy();
  });
});
