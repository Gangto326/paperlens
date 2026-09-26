import { grobidToUserSpace, pageBoxOf, type PageBox } from '@shared/geometry/coords';
import {
  SentenceAligner,
  alignmentStats,
  type AlignmentStats,
  type SentenceAlignment,
} from '@shared/mapping/align';
import {
  TextItemIndex,
  candidateStats,
  findCandidates,
  type CandidateStats,
  type SentenceCandidates,
} from '@shared/mapping/candidates';
import {
  InlineEquationDetector,
  equationStats,
  type EquationDetection,
  type EquationStats,
} from '@shared/mapping/equations';
import { NORMALIZER_VERSION, normalizeText } from '@shared/normalize/normalizer';
import {
  SCHEMA_VERSION,
  type ExcludedBlock,
  type ExtractionDocument,
  type Page,
  type Paper,
  type Pipeline,
  type Rect,
  type Sentence,
  type SourceMapDocument,
  type SourceSpan,
  type TextItemRecord,
} from '@shared/schema';
import { DEFAULT_GROBID_CONFIG } from '../parser/grobid-client';
import { normalizeTei } from '../parser/tei-normalize';
import { PARSER_NAME, SEGMENTER_VERSION } from './revision';

/**
 * document.json 조립(COMMIT_PLAN C1.14). 파일을 읽거나 쓰지 않는 순수 함수라서 실샘플·합성 입력으로 검사할 수 있다.
 *
 * 입력은 C1.5(pages·source-map)·C1.7(TEI)의 산출물이고, 문장마다
 *   normalizeTei(C1.8) → findCandidates(C1.11) → SentenceAligner.align(C1.12) → InlineEquationDetector.detect(C1.13)
 * 을 이어 `sourceSpans`·`mappingStatus`·`mappingConfidence`·`equations`·`en`을 채운다.
 * - `enRaw`는 TEI 원문 그대로, `en`은 정규화(C1.9)한 뒤 인라인 수식을 [EQ_n]으로 바꾼 번역용 문자열(PLAN 5.4).
 * - `rects`는 GROBID 좌표를 user space로 옮긴 것(C1.10, 저장 기준 `pdf_user_space`). 옮기지 못한 사각형은
 *   입력 그대로 두고 경고를 남긴다.
 * - 읽기 순서 경고(PLAN 5.2): 같은 문단의 이웃 문장이 PDF 텍스트 항목 순서에서 거꾸로면 두 문장에
 *   `reading_order_mismatch`를 표시한다. 재정렬하지 않는다.
 * - 후보·정렬·수식 통계에서 0건 사유와 비정상 건수를 문서 경고로 남긴다.
 */
export interface BuildDocumentInput {
  paper: {
    pdfSha256: string;
    fileName: string;
    originalPath?: string | null;
    importedAt: string;
  };
  /** textQuality가 채워진 페이지(saveTextItems 결과). pageIndex 순. */
  pages: Page[];
  sourceMap: SourceMapDocument;
  tei: string;
  parser: {
    /** GROBID /api/version. 모르면 null(경고). */
    version: string | null;
    configHash: string;
    /** 사용자에게 안내한 이미지 태그. 버전이 여기서 나온 것과 다르면 경고. 기본은 DEFAULT_GROBID_CONFIG. */
    imageTag?: string;
  };
}

export interface ReadingOrderStats {
  /** 같은 문단에서 앞 문장과 비교한 쌍의 수(둘 다 스팬이 있을 때만). */
  checked: number;
  mismatches: number;
}

export interface BuildDocumentStats {
  candidates: CandidateStats;
  alignment: AlignmentStats;
  equations: EquationStats;
  readingOrder: ReadingOrderStats;
}

export interface BuildDocumentResult {
  document: ExtractionDocument;
  stats: BuildDocumentStats;
}

export const READING_ORDER_WARNING = 'reading_order_mismatch';

/** 이미지 태그 `grobid/grobid:0.9.1-crf`에서 버전 `0.9.1`을 뽑는다. 형식이 다르면 null. */
export function versionOfImageTag(imageTag: string): string | null {
  const m = /:(\d+\.\d+\.\d+)/.exec(imageTag);
  return m ? m[1]! : null;
}

function firstPosition(
  spans: readonly SourceSpan[],
  byId: ReadonlyMap<string, TextItemRecord>,
): [number, number, number] | null {
  const span = spans[0];
  if (!span) return null;
  const item = byId.get(span.textItemId);
  if (!item) return null;
  return [item.pageIndex, item.index, span.utf16Start];
}

function before(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]!;
  }
  return false;
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function toUserSpace(rect: Rect, pageBoxAt: (i: number) => PageBox | undefined): Rect | null {
  if (rect.coordinateSpace === 'pdf_user_space') return rect;
  const box = pageBoxAt(rect.pageIndex);
  if (!box || !(rect.width > 0) || !(rect.height > 0)) return null;
  return grobidToUserSpace(rect, box);
}

export function buildExtractionDocument(input: BuildDocumentInput): BuildDocumentResult {
  const { pages, sourceMap } = input;
  const pdfSha256 = input.paper.pdfSha256;
  if (sourceMap.pdfSha256 !== pdfSha256) {
    throw new Error(
      `source-map의 pdfSha256(${sourceMap.pdfSha256})이 논문(${pdfSha256})과 다릅니다`,
    );
  }
  if (pages.length === 0) throw new Error('페이지가 없습니다');
  pages.forEach((p, i) => {
    if (p.pageIndex !== i)
      throw new Error(`pages[${i}].pageIndex=${p.pageIndex}: 순서가 어긋납니다`);
  });
  const extractionRevision = sourceMap.extractionRevision;

  const tei = normalizeTei(input.tei, { pdfSha256, extractionRevision });

  const items = sourceMap.textItems;
  const byId = new Map(items.map((it) => [it.id, it]));
  const fontById = new Map(sourceMap.fonts.map((f) => [f.id, f.name]));
  const pageBoxAt = (i: number): PageBox | undefined => {
    const page = pages[i];
    return page ? pageBoxOf(page) : undefined;
  };
  const index = new TextItemIndex(items);
  const aligner = new SentenceAligner(items);
  const detector = new InlineEquationDetector(
    items,
    sourceMap.fonts.length > 0 ? { fontNameOf: (f) => fontById.get(f) } : {},
  );

  const candidateResults: SentenceCandidates[] = [];
  const alignments: SentenceAlignment[] = [];
  const detections: EquationDetection[] = [];
  const sentences: Sentence[] = [];
  for (const s of tei.sentences) {
    const cand = findCandidates(s, index, pageBoxAt);
    const al = aligner.align(s, cand);
    const en = normalizeText(s.enRaw).text.trim();
    const det = detector.detect({ id: s.id, en, sourceSpans: al.sourceSpans });
    candidateResults.push(cand);
    alignments.push(al);
    detections.push(det);

    const warnings = [...s.warnings];
    for (const r of cand.reasons) warnings.push(`candidates:${r}`);
    if (al.reason) warnings.push(`alignment:${al.reason}`);
    for (const w of det.warnings) warnings.push(`equations:${w}`);
    for (const r of cand.perRect) {
      if (r.rect.coordinateSpace !== 'pdf_user_space') pushUnique(warnings, 'rect_not_transformed');
    }

    sentences.push({
      ...s,
      en: det.en,
      sourceSpans: al.sourceSpans,
      rects: cand.perRect.map((r) => r.rect),
      mappingStatus: al.status,
      mappingConfidence: al.confidence,
      equations: det.equations,
      warnings,
    });
  }

  // 읽기 순서(PLAN 5.2): 같은 문단의 이웃 문장이 PDF 항목 순서에서 거꾸로면 두 문장 모두 표시한다.
  const readingOrder: ReadingOrderStats = { checked: 0, mismatches: 0 };
  for (let i = 1; i < sentences.length; i++) {
    const prev = sentences[i - 1]!;
    const cur = sentences[i]!;
    if (prev.paragraphId !== cur.paragraphId) continue;
    const a = firstPosition(prev.sourceSpans, byId);
    const b = firstPosition(cur.sourceSpans, byId);
    if (!a || !b) continue;
    readingOrder.checked++;
    if (before(b, a)) {
      readingOrder.mismatches++;
      pushUnique(prev.warnings, READING_ORDER_WARNING);
      pushUnique(cur.warnings, READING_ORDER_WARNING);
    }
  }

  const warnings = [...tei.warnings];
  const excludedBlocks: ExcludedBlock[] = tei.excludedBlocks.map((block) => {
    const rects: Rect[] = [];
    for (const rect of block.rects) {
      const converted = toUserSpace(rect, pageBoxAt);
      if (converted) rects.push(converted);
      else {
        rects.push(rect);
        pushUnique(warnings, `excluded_rect_not_transformed:${block.id}`);
      }
    }
    return { ...block, rects };
  });

  const stats: BuildDocumentStats = {
    candidates: candidateStats(candidateResults),
    alignment: alignmentStats(alignments),
    equations: equationStats(detections),
    readingOrder,
  };
  for (const [reason, n] of Object.entries(stats.candidates.zeroByReason)) {
    if (n > 0) warnings.push(`candidates_zero:${reason}=${n}`);
  }
  const { byStatus } = stats.alignment;
  if (byStatus.uncertain > 0) warnings.push(`alignment_uncertain=${byStatus.uncertain}`);
  if (byStatus.unmapped > 0) warnings.push(`alignment_unmapped=${byStatus.unmapped}`);
  if (stats.equations.uncertain > 0)
    warnings.push(`equations_uncertain=${stats.equations.uncertain}`);
  if (readingOrder.mismatches > 0)
    warnings.push(`${READING_ORDER_WARNING}=${readingOrder.mismatches}`);

  const imageTag = input.parser.imageTag ?? DEFAULT_GROBID_CONFIG.imageTag;
  const expected = versionOfImageTag(imageTag);
  const parserVersion = input.parser.version;
  if (parserVersion === null) warnings.push('parser_version_unknown');
  else if (expected && !parserVersion.startsWith(expected)) {
    warnings.push(`parser_version_mismatch:${parserVersion}!=${expected}`);
  }

  const paper: Paper = {
    id: `paper_${pdfSha256.slice(0, 16)}`,
    pdfSha256,
    fileName: input.paper.fileName,
    originalPath: input.paper.originalPath ?? null,
    title: tei.metadata.title,
    authors: tei.metadata.authors,
    year: tei.metadata.year,
    doi: tei.metadata.doi,
    pageCount: pages.length,
    importedAt: input.paper.importedAt,
  };
  const pipeline: Pipeline = {
    extractionRevision,
    parserName: PARSER_NAME,
    parserVersion: parserVersion ?? 'unknown',
    parserConfigHash: input.parser.configHash,
    pdfjsVersion: sourceMap.pdfjsVersion,
    normalizerVersion: NORMALIZER_VERSION,
    segmenterVersion: SEGMENTER_VERSION,
  };

  const document: ExtractionDocument = {
    schemaVersion: SCHEMA_VERSION,
    paper,
    pipeline,
    pages,
    sections: tei.sections,
    sentences,
    excludedBlocks,
    bibliography: tei.bibliography,
    warnings,
  };
  return { document, stats };
}
