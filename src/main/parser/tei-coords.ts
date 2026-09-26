import type { Rect } from '@shared/schema/types';

/**
 * GROBID `coords` 속성 값을 Rect 목록으로 바꾼다.
 * 형식: `page,x,y,w,h;page,x,y,w,h;…` — page는 1-based, 원점은 페이지 왼쪽 위, 단위는 PDF 포인트(pdfalto 기준).
 * 좌표는 변환하지 않고 `grobid_top_left_pdf_units`로 보존한다. 변환은 C1.10에서 한다.
 */
export const GROBID_RECT_TRANSFORM_VERSION = 'none';

export interface ParsedCoords {
  rects: Rect[];
  /** 비어 있거나 형식이 깨진 조각의 사유. 좌표가 없어도 문장은 버리지 않는다. */
  warnings: string[];
}

export function parseGrobidCoords(coords: string | undefined): ParsedCoords {
  const rects: Rect[] = [];
  const warnings: string[] = [];
  if (coords === undefined || coords.trim() === '') {
    warnings.push('coords_missing');
    return { rects, warnings };
  }
  for (const piece of coords.split(';')) {
    const trimmed = piece.trim();
    if (trimmed === '') continue;
    const parts = trimmed.split(',').map((v) => Number(v));
    if (parts.length !== 5 || parts.some((v) => !Number.isFinite(v))) {
      warnings.push(`coords_malformed:${trimmed.slice(0, 40)}`);
      continue;
    }
    const [page, x, y, width, height] = parts as [number, number, number, number, number];
    if (!Number.isInteger(page) || page < 1) {
      warnings.push(`coords_page_invalid:${page}`);
      continue;
    }
    rects.push({
      pageIndex: page - 1,
      x,
      y,
      width,
      height,
      coordinateSpace: 'grobid_top_left_pdf_units',
      transformVersion: GROBID_RECT_TRANSFORM_VERSION,
    });
  }
  if (rects.length === 0 && warnings.length === 0) warnings.push('coords_missing');
  return { rects, warnings };
}

/** rects가 걸치는 페이지 인덱스를 오름차순·중복 없이 돌려준다. */
export function pageIndicesOf(rects: Rect[]): number[] {
  return [...new Set(rects.map((r) => r.pageIndex))].sort((a, b) => a - b);
}
