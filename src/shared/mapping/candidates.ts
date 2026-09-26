import type { Rect, Sentence, TextItemRecord } from '@shared/schema/types';
import { grobidToUserSpace, textItemToUserRect, type Box, type PageBox } from '../geometry/coords';

/**
 * 후보 검색 규칙의 버전. 여유·겹침 판정·정렬 규칙이 바뀌면 올린다(extraction revision 입력 후보).
 * v1: 문장 사각형을 user space로 옮겨 사방 marginPt만큼 넓힌 뒤, 같은 페이지에서 사각형이 겹치는
 *     PDF.js 텍스트 항목을 전부 후보로 삼는다(공백만 있는 항목 포함). 항목 순서는 페이지·index 오름차순.
 */
export const CANDIDATE_SEARCH_VERSION = '1';

/**
 * 문장 사각형을 사방으로 넓히는 여유(PDF 포인트). GROBID(pdfalto) 사각형은 글리프 상자 기준이고
 * PDF.js 항목 상자는 기준선~기준선+height(디센더 미포함)라 경계가 1~2pt 어긋날 수 있다.
 * 실샘플 3편에서는 0~3pt가 같은 결과(단어 적중 99.6/98.1/98.4%, 후보 0건 문장 0)였고 5pt부터 이웃 줄 항목이
 * 섞여 들었다(후보 중앙값 3→5). 좌표 반올림·디센더 차이에 대비한 여유로 2를 두되 이웃 줄에는 닿지 않게 한다.
 */
export const DEFAULT_RECT_MARGIN_PT = 2;

/** 후보 검색이 항목을 내지 못한 사유. 문장 단위로는 모든 사각형의 사유 합집합. */
export type CandidateReason =
  /** 문장에 좌표가 하나도 없다(GROBID coords 누락·깨짐). */
  | 'no_rects'
  /** 사각형의 페이지에 대한 PageBox 또는 텍스트 항목이 없다. */
  | 'page_missing'
  /** 폭·높이가 0 이하이거나 유한하지 않다. */
  | 'rect_degenerate'
  /** 넓힌 사각형과 겹치는 항목이 없다(그림 안 글자·벡터 텍스트 등). */
  | 'no_overlap';

export interface RectCandidates {
  /** user space(`pdf_user_space`)로 옮긴 문장 사각형. 변환하지 못한 경우(page_missing·rect_degenerate)는 입력 그대로. */
  rect: Rect;
  /** 이 사각형과 겹치는 항목 ID(index 순). */
  textItemIds: string[];
  reason?: CandidateReason;
}

export interface SentenceCandidates {
  sentenceId: string;
  /** 모든 사각형의 후보 합집합. 페이지 오름차순 → 항목 index 오름차순, 중복 없음. */
  textItemIds: string[];
  /** 사각형별 결과. GROBID는 대체로 줄마다 사각형 하나를 내므로 줄 단위 정렬(C1.12)에 쓸 수 있다. */
  perRect: RectCandidates[];
  /** textItemIds가 비어 있을 때의 사유(중복 없음). 후보가 하나라도 있으면 빈 배열. */
  reasons: CandidateReason[];
}

export interface CandidateSearchOptions {
  /** 사각형 확장 여유(pt). 기본 DEFAULT_RECT_MARGIN_PT. */
  marginPt?: number;
}

interface IndexedItem {
  item: TextItemRecord;
  box: Box;
}

/** 행 버킷 높이(pt). 본문 글줄 높이(9~12pt)와 비슷하게 잡아 한 줄 질의가 버킷 1~2개에 닿게 한다. */
const ROW_BUCKET_PT = 16;

/** 한 페이지의 항목을 user space y 행 버킷으로 나눈 공간 인덱스. 항목 수백~수천 개 규모면 충분하다. */
class PageItemIndex {
  private readonly buckets = new Map<number, IndexedItem[]>();
  readonly size: number;

  constructor(items: readonly TextItemRecord[]) {
    this.size = items.length;
    for (const item of items) {
      const box = textItemToUserRect(item);
      const entry: IndexedItem = { item, box };
      const lo = Math.floor(box.y / ROW_BUCKET_PT);
      const hi = Math.floor((box.y + box.height) / ROW_BUCKET_PT);
      for (let b = lo; b <= hi; b++) {
        const bucket = this.buckets.get(b);
        if (bucket) bucket.push(entry);
        else this.buckets.set(b, [entry]);
      }
    }
  }

  /** query와 겹치는 항목을 index 오름차순으로 돌려준다. */
  query(query: Box): TextItemRecord[] {
    const lo = Math.floor(query.y / ROW_BUCKET_PT);
    const hi = Math.floor((query.y + query.height) / ROW_BUCKET_PT);
    const seen = new Set<number>();
    const out: TextItemRecord[] = [];
    for (let b = lo; b <= hi; b++) {
      const bucket = this.buckets.get(b);
      if (!bucket) continue;
      for (const { item, box } of bucket) {
        if (seen.has(item.index)) continue;
        if (overlaps(box, query)) {
          seen.add(item.index);
          out.push(item);
        }
      }
    }
    out.sort((a, b) => a.index - b.index);
    return out;
  }
}

/** 열린 구간 겹침. 한쪽 폭·높이가 0이면 그 점이 상대 안에 있을 때만 참. */
export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** 문서 전체 텍스트 항목의 페이지별 공간 인덱스. 한 번 만들어 모든 문장 검색에 재사용한다. */
export class TextItemIndex {
  private readonly pages = new Map<number, PageItemIndex>();

  constructor(items: Iterable<TextItemRecord>) {
    const byPage = new Map<number, TextItemRecord[]>();
    for (const item of items) {
      const list = byPage.get(item.pageIndex);
      if (list) list.push(item);
      else byPage.set(item.pageIndex, [item]);
    }
    for (const [pageIndex, list] of byPage) this.pages.set(pageIndex, new PageItemIndex(list));
  }

  hasPage(pageIndex: number): boolean {
    return this.pages.has(pageIndex);
  }

  /** 페이지 항목 수(없으면 0). */
  pageSize(pageIndex: number): number {
    return this.pages.get(pageIndex)?.size ?? 0;
  }

  /** pageIndex 페이지에서 user space Box와 겹치는 항목(index 순). 페이지가 없으면 빈 배열. */
  query(pageIndex: number, box: Box): TextItemRecord[] {
    return this.pages.get(pageIndex)?.query(box) ?? [];
  }
}

function isDegenerate(rect: Rect): boolean {
  return (
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  );
}

function expand(rect: Rect, margin: number): Box {
  return {
    x: rect.x - margin,
    y: rect.y - margin,
    width: rect.width + 2 * margin,
    height: rect.height + 2 * margin,
  };
}

/**
 * 문장 사각형마다 같은 페이지의 겹치는 텍스트 항목을 찾는다.
 * - GROBID 좌표(`grobid_top_left_pdf_units`)는 pageBoxOf(pageIndex)로 user space로 옮긴다.
 *   이미 `pdf_user_space`인 사각형은 그대로 쓴다(C1.14가 변환해 저장한 경우).
 * - 항목 문자열은 보지 않는다. 문자열 정렬로 SourceSpan을 확정하는 일은 C1.12.
 */
export function findCandidates(
  sentence: Pick<Sentence, 'id' | 'rects'>,
  index: TextItemIndex,
  pageBoxOf: (pageIndex: number) => PageBox | undefined,
  opts: CandidateSearchOptions = {},
): SentenceCandidates {
  const margin = opts.marginPt ?? DEFAULT_RECT_MARGIN_PT;
  if (!Number.isFinite(margin) || margin < 0) throw new Error(`marginPt must be ≥ 0: ${margin}`);

  const perRect: RectCandidates[] = [];
  const reasons = new Set<CandidateReason>();
  const found = new Map<string, TextItemRecord>();

  if (sentence.rects.length === 0) reasons.add('no_rects');
  for (const raw of sentence.rects) {
    const box = pageBoxOf(raw.pageIndex);
    if (!box || !index.hasPage(raw.pageIndex)) {
      perRect.push({ rect: raw, textItemIds: [], reason: 'page_missing' });
      reasons.add('page_missing');
      continue;
    }
    // 변환 전에 판정한다: 음수 폭·높이는 변환(네 모서리의 경계 상자)을 거치면 양수로 뒤집혀 숨는다.
    if (isDegenerate(raw)) {
      perRect.push({ rect: raw, textItemIds: [], reason: 'rect_degenerate' });
      reasons.add('rect_degenerate');
      continue;
    }
    const rect = raw.coordinateSpace === 'pdf_user_space' ? raw : grobidToUserSpace(raw, box);
    const items = index.query(rect.pageIndex, expand(rect, margin));
    if (items.length === 0) {
      perRect.push({ rect, textItemIds: [], reason: 'no_overlap' });
      reasons.add('no_overlap');
      continue;
    }
    for (const item of items) found.set(item.id, item);
    perRect.push({ rect, textItemIds: items.map((i) => i.id) });
  }

  const textItemIds = [...found.values()]
    .sort((a, b) => a.pageIndex - b.pageIndex || a.index - b.index)
    .map((i) => i.id);
  return {
    sentenceId: sentence.id,
    textItemIds,
    perRect,
    reasons: textItemIds.length === 0 ? [...reasons] : [],
  };
}

export interface CandidateStats {
  sentences: number;
  withCandidates: number;
  /** 후보 0건 문장 수와 사유별 건수(한 문장이 여러 사유를 가질 수 있어 합이 zero보다 클 수 있다). */
  zero: number;
  zeroByReason: Record<CandidateReason, number>;
  /** 후보 수 분포(후보가 있는 문장만). */
  min: number;
  median: number;
  max: number;
  mean: number;
}

/** 문장별 후보 결과의 분포. 추출 경고·커밋 본문 기록용. */
export function candidateStats(results: readonly SentenceCandidates[]): CandidateStats {
  const counts = results.map((r) => r.textItemIds.length).filter((n) => n > 0);
  counts.sort((a, b) => a - b);
  const zeroByReason: Record<CandidateReason, number> = {
    no_rects: 0,
    page_missing: 0,
    rect_degenerate: 0,
    no_overlap: 0,
  };
  let zero = 0;
  for (const r of results) {
    if (r.textItemIds.length > 0) continue;
    zero++;
    for (const reason of r.reasons) zeroByReason[reason]++;
  }
  const sum = counts.reduce((a, b) => a + b, 0);
  return {
    sentences: results.length,
    withCandidates: counts.length,
    zero,
    zeroByReason,
    min: counts[0] ?? 0,
    median: counts.length === 0 ? 0 : counts[Math.floor(counts.length / 2)]!,
    max: counts[counts.length - 1] ?? 0,
    mean: counts.length === 0 ? 0 : sum / counts.length,
  };
}
