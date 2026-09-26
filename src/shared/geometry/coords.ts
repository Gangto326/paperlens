import type { Page, Rect, TextItemRecord } from '@shared/schema/types';

/**
 * 좌표계 변환 규칙의 버전. 식이 바뀌면 올린다(변환된 Rect.transformVersion에 기록).
 * v1: PDF.js PageViewport(6.x)와 같은 행렬. GROBID 공간 = 회전 반영·userUnit 미반영·scale 1 뷰포트.
 */
export const COORD_TRANSFORM_VERSION = '1';

/** PDF/PDF.js 행렬 [a, b, c, d, e, f]: (x, y) → (a·x + c·y + e, b·x + d·y + f). */
export type Matrix = readonly [number, number, number, number, number, number];

/** coordinateSpace가 없는 축 정렬 사각형(뷰포트 px 등 저장하지 않는 값용). */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 변환에 필요한 페이지 정보만. Page에서 뽑거나(pageBoxOf) 테스트에서 직접 만든다. */
export interface PageBox {
  /** PDF.js `view`(= CropBox ∩ MediaBox), user space [x1, y1, x2, y2]. */
  viewBox: readonly [number, number, number, number];
  /** PDF /Rotate. 0·90·180·270이 아니면 normalizeRotation으로 맞춘다. */
  rotation: number;
  /** PDF /UserUnit. 뷰포트 scale에 곱해진다(PDF.js와 동일). */
  userUnit: number;
}

export function pageBoxOf(page: Page): PageBox {
  return { viewBox: page.cropBox, rotation: page.rotation, userUnit: page.userUnit };
}

/** PDF /Rotate 값(음수·360 이상 포함)을 0·90·180·270으로 정규화한다. */
export function normalizeRotation(rotate: number): 0 | 90 | 180 | 270 {
  const r = (((Math.round(rotate / 90) * 90) % 360) + 360) % 360;
  return r as 0 | 90 | 180 | 270;
}

/**
 * user space → 뷰포트(왼쪽 위 원점, y 아래, CSS px) 행렬.
 * PDF.js `PageViewport`(display_utils)와 같은 식이다: scale에 userUnit을 곱하고, viewBox 중심을 기준으로
 * 회전한 뒤 원점을 왼쪽 위로 옮긴다. 검증은 coords.pdfjs.test.ts에서 실제 getViewport()와 대조한다.
 */
export function viewportMatrix(box: PageBox, scale: number, rotation = box.rotation): Matrix {
  const [x1, y1, x2, y2] = box.viewBox;
  const s = scale * box.userUnit;
  const centerX = (x2 + x1) / 2;
  const centerY = (y2 + y1) / 2;
  let a: number, b: number, c: number, d: number;
  switch (normalizeRotation(rotation)) {
    case 180:
      [a, b, c, d] = [-1, 0, 0, 1];
      break;
    case 90:
      [a, b, c, d] = [0, 1, 1, 0];
      break;
    case 270:
      [a, b, c, d] = [0, -1, -1, 0];
      break;
    default:
      [a, b, c, d] = [1, 0, 0, -1];
  }
  let offsetX: number, offsetY: number;
  if (a === 0) {
    offsetX = Math.abs(centerY - y1) * s;
    offsetY = Math.abs(centerX - x1) * s;
  } else {
    offsetX = Math.abs(centerX - x1) * s;
    offsetY = Math.abs(centerY - y1) * s;
  }
  return [
    a * s,
    b * s,
    c * s,
    d * s,
    offsetX - a * s * centerX - c * s * centerY,
    offsetY - b * s * centerX - d * s * centerY,
  ];
}

/** 뷰포트 크기(CSS px). 90·270이면 폭·높이가 바뀐다. */
export function viewportSize(
  box: PageBox,
  scale: number,
  rotation = box.rotation,
): { width: number; height: number } {
  const [x1, y1, x2, y2] = box.viewBox;
  const s = scale * box.userUnit;
  const w = (x2 - x1) * s;
  const h = (y2 - y1) * s;
  const r = normalizeRotation(rotation);
  return r === 90 || r === 270 ? { width: h, height: w } : { width: w, height: h };
}

/**
 * GROBID(pdfalto) 좌표 공간 → user space 행렬의 역. GROBID 좌표는 회전이 반영된 표시 페이지의
 * 왼쪽 위가 원점이고 단위는 PDF 포인트다(3편 실샘플에서 y 뒤집기로 문장 단어 90~94% 적중, 뒤집지 않으면 6~10%).
 * pdfalto는 /UserUnit을 무시한다고 보고 userUnit=1로 둔다(가정 — UserUnit 문서 실측 없음).
 * 회전 페이지에 대한 pdfalto 동작도 실측 전이며, PDF.js와 같은 방향으로 회전한다고 가정한다.
 */
export function grobidMatrix(box: PageBox): Matrix {
  return viewportMatrix({ ...box, userUnit: 1 }, 1);
}

export function invertMatrix(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (det === 0 || !Number.isFinite(det)) throw new Error('matrix is not invertible');
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** 네 모서리를 변환한 뒤 축 정렬 경계 상자를 돌려준다. 90도 배수 회전에서는 손실이 없다. */
export function transformBox(m: Matrix, box: Box): Box {
  const pts = [
    applyMatrix(m, box.x, box.y),
    applyMatrix(m, box.x + box.width, box.y),
    applyMatrix(m, box.x, box.y + box.height),
    applyMatrix(m, box.x + box.width, box.y + box.height),
  ];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function assertSpace(rect: Rect, expected: Rect['coordinateSpace']): void {
  if (rect.coordinateSpace !== expected) {
    throw new Error(`expected ${expected} rect, got ${rect.coordinateSpace}`);
  }
}

/** GROBID 사각형(`grobid_top_left_pdf_units`) → user space(`pdf_user_space`). */
export function grobidToUserSpace(rect: Rect, box: PageBox): Rect {
  assertSpace(rect, 'grobid_top_left_pdf_units');
  const b = transformBox(invertMatrix(grobidMatrix(box)), rect);
  return {
    pageIndex: rect.pageIndex,
    ...b,
    coordinateSpace: 'pdf_user_space',
    transformVersion: COORD_TRANSFORM_VERSION,
  };
}

/** user space → GROBID 사각형. 비교·디버그용(저장 좌표는 user space가 기준). */
export function userSpaceToGrobid(rect: Rect, box: PageBox): Rect {
  assertSpace(rect, 'pdf_user_space');
  const b = transformBox(grobidMatrix(box), rect);
  return {
    pageIndex: rect.pageIndex,
    ...b,
    coordinateSpace: 'grobid_top_left_pdf_units',
    transformVersion: COORD_TRANSFORM_VERSION,
  };
}

/** user space → 화면 뷰포트 Box(CSS px). rotation을 주면 사용자가 돌려 본 상태를 반영한다. */
export function userSpaceToViewport(
  rect: Rect,
  box: PageBox,
  scale: number,
  rotation = box.rotation,
): Box {
  assertSpace(rect, 'pdf_user_space');
  return transformBox(viewportMatrix(box, scale, rotation), rect);
}

/** 화면 뷰포트 Box(CSS px) → user space Rect. 선택 영역을 저장 좌표로 옮길 때 쓴다. */
export function viewportToUserSpace(
  vp: Box,
  pageIndex: number,
  box: PageBox,
  scale: number,
  rotation = box.rotation,
): Rect {
  const b = transformBox(invertMatrix(viewportMatrix(box, scale, rotation)), vp);
  return {
    pageIndex,
    ...b,
    coordinateSpace: 'pdf_user_space',
    transformVersion: COORD_TRANSFORM_VERSION,
  };
}

/**
 * PDF.js 텍스트 항목의 user space 사각형. transform의 (e, f)는 기준선 시작점, width·height는 이미
 * user space 단위이므로 (a, b)·(c, d) 방향 단위 벡터로 width·height만큼 늘린 상자의 경계다.
 * 가로 글은 [e, f, e+width, f+height] — PDF.js TextLayer처럼 디센더는 포함하지 않는다.
 */
export function textItemToUserRect(
  item: Pick<TextItemRecord, 'pageIndex' | 'transform' | 'width' | 'height'>,
): Rect {
  const [a, b, c, d, e, f] = item.transform;
  const lx = Math.hypot(a, b);
  const ly = Math.hypot(c, d);
  // 퇴화한 행렬(길이 0)은 축 방향으로 둔다.
  const ux: [number, number] = lx === 0 ? [1, 0] : [a / lx, b / lx];
  const uy: [number, number] = ly === 0 ? [0, 1] : [c / ly, d / ly];
  const ex: [number, number] = [ux[0] * item.width, ux[1] * item.width];
  const ey: [number, number] = [uy[0] * item.height, uy[1] * item.height];
  const xs = [e, e + ex[0], e + ey[0], e + ex[0] + ey[0]];
  const ys = [f, f + ex[1], f + ey[1], f + ex[1] + ey[1]];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    pageIndex: item.pageIndex,
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
    coordinateSpace: 'pdf_user_space',
    transformVersion: COORD_TRANSFORM_VERSION,
  };
}
