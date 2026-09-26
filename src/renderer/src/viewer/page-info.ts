import { normalizeRotation } from '@shared/geometry/coords';
import type { Page } from '@shared/schema';

export { normalizeRotation };

/** PDFPageProxy에서 필요한 최소 속성. 테스트에서 프록시 없이 만들 수 있게 분리한다. */
export interface PageProxyLike {
  view: number[];
  rotate: number;
  userUnit: number;
}

/**
 * 페이지 뷰 정보를 스키마 Page로 만든다.
 * - PDF.js 공개 API는 CropBox∩MediaBox를 `view`로만 준다. MediaBox 자체는 노출하지 않으므로
 *   mediaBox는 view와 같게 두고 warning을 남긴다. GROBID(pdfalto) 페이지 크기와의 대조는
 *   `@shared/geometry/coords.samples.test.ts`에서 한다(3편 모두 view와 일치).
 * - width/height는 회전을 반영한 표시 크기(PDF 단위, scale 1, userUnit 반영).
 */
export function pageInfoFromProxy(pageIndex: number, page: PageProxyLike): Page {
  const [x1, y1, x2, y2] = page.view as [number, number, number, number];
  const rotation = normalizeRotation(page.rotate);
  const w = (x2 - x1) * page.userUnit;
  const h = (y2 - y1) * page.userUnit;
  const swapped = rotation === 90 || rotation === 270;
  const warnings: string[] = ['mediaBox_unavailable_equals_view'];
  if (page.userUnit !== 1) warnings.push(`userUnit=${page.userUnit}`);
  if (x1 !== 0 || y1 !== 0) warnings.push('view_origin_not_zero');
  return {
    pageIndex,
    pdfPageNumber: pageIndex + 1,
    width: swapped ? h : w,
    height: swapped ? w : h,
    rotation,
    userUnit: page.userUnit,
    mediaBox: [x1, y1, x2, y2],
    cropBox: [x1, y1, x2, y2],
    coordinateSpace: 'pdf_user_space',
    textQuality: 'ok',
    warnings,
  };
}
