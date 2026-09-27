import type {
  EquationPlaceholder,
  ExcludedBlock,
  ExtractionDocument,
  Page,
  Rect,
  Sentence,
} from '../schema/types';

/**
 * 화면 선택 → 문장 해석(C1.15, PLAN 5.6 4~7). DOM을 모르는 순수 모듈이다.
 *
 * - renderer는 document.json 전체가 아니라 `SentenceIndex`(문장의 id·order·en·상태·스팬·사각형과 제외 블록 사각형)만 받는다.
 * - 선택은 텍스트 항목 단위의 문자 범위 `TextRange[]`로 들어온다(utf16 offset은 항목 `str` 기준, SourceSpan과 같다).
 *   PDF.js TextLayer의 span 하나가 항목 하나와 1:1이라고 가정하지 않는다 — DOM 쪽 어댑터가 어떤 노드를 어떤 항목·offset으로
 *   옮겼든 이 모듈은 항목 ID와 offset만 본다.
 * - 드래그: 범위와 겹치는 스팬의 문장을 모두 모아 중복 제거 후 본문 순서(order)로 돌려준다. 부분 드래그도 전체 문장.
 *   공백만 선택하면 빈 결과(다른 문장을 대신 보여주지 않는다).
 * - 클릭(caret, start === end): 그 위치를 덮는 스팬의 문장. 스팬 여러 개면 시작이 가장 가까운 것, 다음은 order.
 *   스팬이 없으면(미연결 문장·스팬 밖 글자) 클릭 지점의 user space 좌표로 문장 사각형을 찾는다 — 단, 제외 블록 사각형 안이면
 *   빈 결과. 사각형 여러 개면 가장 작은 것.
 */
export const SELECTION_RESOLVER_VERSION = '1';

/** renderer가 받는 문장 요약. 번역 결과는 포함하지 않는다(그건 generation 문서). */
export interface SentenceIndexEntry {
  id: string;
  order: number;
  page: number;
  pages: number[];
  sectionId: string;
  paragraphId: string;
  en: string;
  mappingStatus: Sentence['mappingStatus'];
  mappingConfidence: number | null;
  sourceSpans: Sentence['sourceSpans'];
  /** user space(`pdf_user_space`) */
  rects: Rect[];
  equations: Pick<EquationPlaceholder, 'id' | 'token' | 'detectionStatus'>[];
  warnings: string[];
}

export interface ExcludedBlockIndexEntry {
  id: string;
  type: ExcludedBlock['type'];
  rects: Rect[];
}

export interface SentenceIndex {
  extractionRevision: string;
  pages: Page[];
  sentences: SentenceIndexEntry[];
  excludedBlocks: ExcludedBlockIndexEntry[];
}

/** document.json → renderer용 색인. 문장은 order 순으로 정렬한다. */
export function sentenceIndexOf(doc: ExtractionDocument): SentenceIndex {
  const sentences = [...doc.sentences]
    .sort((a, b) => a.order - b.order)
    .map<SentenceIndexEntry>((s) => ({
      id: s.id,
      order: s.order,
      page: s.page,
      pages: s.pages,
      sectionId: s.sectionId,
      paragraphId: s.paragraphId,
      en: s.en,
      mappingStatus: s.mappingStatus,
      mappingConfidence: s.mappingConfidence ?? null,
      sourceSpans: s.sourceSpans,
      rects: s.rects,
      equations: s.equations.map((e) => ({
        id: e.id,
        token: e.token,
        detectionStatus: e.detectionStatus,
      })),
      warnings: s.warnings,
    }));
  return {
    extractionRevision: doc.pipeline.extractionRevision,
    pages: doc.pages,
    sentences,
    excludedBlocks: doc.excludedBlocks.map((b) => ({ id: b.id, type: b.type, rects: b.rects })),
  };
}

/** 텍스트 항목 하나 안의 선택 문자 범위. offset은 항목 `str`의 utf16 기준, [start, end). start === end는 caret. */
export interface TextRange {
  textItemId: string;
  start: number;
  end: number;
  /** 선택된 글자(공백만 선택했는지 판단용). caret이면 ''. */
  text: string;
}

/** 클릭 지점(문장 사각형 조회용). user space 좌표. */
export interface PointHit {
  pageIndex: number;
  x: number;
  y: number;
}

export type SelectionReason =
  | 'ok'
  /** 범위가 하나도 없음 */
  | 'empty_selection'
  /** 선택한 글자가 공백뿐 */
  | 'whitespace_only'
  /** 글자·지점이 어느 문장에도 속하지 않음(스팬 밖, 사각형 밖) */
  | 'no_sentence'
  /** 클릭 지점이 제외 블록 안 */
  | 'excluded_block';

export interface SelectionResult {
  sentences: SentenceIndexEntry[];
  reason: SelectionReason;
  /** 사각형 조회로 찾은 경우(스팬이 아니라 위치로 찾았으므로 확신이 낮다) */
  byRect: boolean;
}

interface SpanRef {
  sentence: SentenceIndexEntry;
  start: number;
  end: number;
}

function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
}

function area(r: Rect): number {
  return Math.abs(r.width * r.height);
}

/** 문장 색인을 항목별 스팬 표로 만들어 둔 조회기. 문서마다 하나 만든다. */
export class SentenceLookup {
  private readonly byItem = new Map<string, SpanRef[]>();
  private readonly byId = new Map<string, SentenceIndexEntry>();
  private readonly rectsByPage = new Map<number, { rect: Rect; sentence: SentenceIndexEntry }[]>();
  private readonly excludedByPage = new Map<
    number,
    { rect: Rect; block: ExcludedBlockIndexEntry }[]
  >();

  constructor(readonly index: SentenceIndex) {
    for (const s of index.sentences) {
      this.byId.set(s.id, s);
      for (const span of s.sourceSpans) {
        const refs = this.byItem.get(span.textItemId) ?? [];
        refs.push({ sentence: s, start: span.utf16Start, end: span.utf16End });
        this.byItem.set(span.textItemId, refs);
      }
      for (const rect of s.rects) {
        if (rect.coordinateSpace !== 'pdf_user_space') continue;
        const list = this.rectsByPage.get(rect.pageIndex) ?? [];
        list.push({ rect, sentence: s });
        this.rectsByPage.set(rect.pageIndex, list);
      }
    }
    for (const refs of this.byItem.values()) refs.sort((a, b) => a.start - b.start);
    for (const b of index.excludedBlocks) {
      for (const rect of b.rects) {
        if (rect.coordinateSpace !== 'pdf_user_space') continue;
        const list = this.excludedByPage.get(rect.pageIndex) ?? [];
        list.push({ rect, block: b });
        this.excludedByPage.set(rect.pageIndex, list);
      }
    }
  }

  get size(): number {
    return this.byId.size;
  }

  sentenceById(id: string): SentenceIndexEntry | undefined {
    return this.byId.get(id);
  }

  /** 항목에 걸린 스팬(시작 offset 순). 없으면 빈 배열 — 제외 블록·미연결 문장의 글자다. */
  spansOf(textItemId: string): readonly SpanRef[] {
    return this.byItem.get(textItemId) ?? [];
  }

  /**
   * 드래그 해석: 범위와 겹치는 스팬의 문장을 order 순·중복 없이 돌려준다.
   * caret 범위만 있으면 클릭으로 취급한다(resolveCaret).
   */
  resolveRanges(ranges: readonly TextRange[]): SelectionResult {
    if (ranges.length === 0) return { sentences: [], reason: 'empty_selection', byRect: false };
    const dragged = ranges.filter((r) => r.end > r.start);
    if (dragged.length === 0) {
      // 빈 범위가 여럿이면 각 caret의 문장을 모은다. 첫 범위만 보면 범위 순서에 따라 결과가 달라진다.
      const found = new Map<string, SentenceIndexEntry>();
      for (const caret of ranges) {
        const hit = this.resolveCaret({ textItemId: caret.textItemId, offset: caret.start });
        for (const sentence of hit.sentences) found.set(sentence.id, sentence);
      }
      const sentences = [...found.values()].sort((a, b) => a.order - b.order);
      return { sentences, reason: sentences.length ? 'ok' : 'no_sentence', byRect: false };
    }
    if (dragged.every((r) => r.text.trim() === '')) {
      return { sentences: [], reason: 'whitespace_only', byRect: false };
    }
    const found = new Map<string, SentenceIndexEntry>();
    for (const r of dragged) {
      for (const ref of this.spansOf(r.textItemId)) {
        if (r.start < ref.end && r.end > ref.start) found.set(ref.sentence.id, ref.sentence);
      }
    }
    const sentences = [...found.values()].sort((a, b) => a.order - b.order);
    return { sentences, reason: sentences.length ? 'ok' : 'no_sentence', byRect: false };
  }

  /**
   * 클릭 해석: caret이 든 스팬의 문장(스팬 여러 개면 시작이 가장 가까운 것, 다음은 order).
   * caret이 스팬 끝(offset === end)에만 닿으면 그 스팬을 쓴다. 스팬이 없으면 point로 사각형 조회.
   */
  resolveCaret(
    caret: { textItemId: string; offset: number },
    point?: PointHit | null,
  ): SelectionResult {
    const refs = this.spansOf(caret.textItemId);
    let hits = refs.filter((r) => r.start <= caret.offset && caret.offset < r.end);
    if (hits.length === 0) hits = refs.filter((r) => r.end === caret.offset && r.start < r.end);
    if (hits.length > 0) {
      hits.sort(
        (a, b) =>
          caret.offset - a.start - (caret.offset - b.start) || a.sentence.order - b.sentence.order,
      );
      return { sentences: [hits[0]!.sentence], reason: 'ok', byRect: false };
    }
    return point
      ? this.resolvePoint(point)
      : { sentences: [], reason: 'no_sentence', byRect: false };
  }

  /** 지점 해석(user space): 제외 블록 안이면 빈 결과, 아니면 지점을 덮는 가장 작은 문장 사각형의 문장. */
  resolvePoint(point: PointHit): SelectionResult {
    const excluded = this.excludedByPage.get(point.pageIndex) ?? [];
    if (excluded.some((e) => contains(e.rect, point.x, point.y))) {
      return { sentences: [], reason: 'excluded_block', byRect: true };
    }
    const hits = (this.rectsByPage.get(point.pageIndex) ?? []).filter((e) =>
      contains(e.rect, point.x, point.y),
    );
    if (hits.length === 0) return { sentences: [], reason: 'no_sentence', byRect: true };
    hits.sort((a, b) => area(a.rect) - area(b.rect) || a.sentence.order - b.sentence.order);
    return { sentences: [hits[0]!.sentence], reason: 'ok', byRect: true };
  }
}
