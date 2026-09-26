import type {
  MappingStatus,
  NormalizationMap,
  Sentence,
  SourceSpan,
  TextItemRecord,
} from '@shared/schema/types';
import {
  createNormalizationMap,
  normalizeText,
  toNormRange,
  toRawRange,
} from '../normalize/normalizer';
import type { SentenceCandidates } from './candidates';

/**
 * 후보 내 문자열 정렬 규칙의 버전(extraction revision 입력 후보). 조립·정렬·판정 규칙이 바뀌면 올린다.
 * v1: 후보 항목(페이지→index 순)을 원문 그대로 이어 붙이되 hasEOL·페이지 경계에는 줄바꿈, index 건너뜀에는
 *     공백을 끼운다. 조립 문자열과 문장을 각각 정규화(normalizer v1)한 뒤 정확 부분 문자열을 먼저 찾고,
 *     없으면 문장 전체를 조립 문자열의 한 구간에 맞추는 fitting 정렬(치환·삽입·삭제 비용 1)로 최소 편집 거리
 *     구간을 고른다. 편집 거리/문장 길이 비율로 mapped·uncertain·unmapped를 가른다.
 */
export const ALIGNMENT_VERSION = '1';

/** 편집 거리 비율(거리 ÷ 정규화 문장 길이) 상한. 이하이면 mapped. */
export const DEFAULT_MAPPED_MAX_RATIO = 0.1;
/** 이하이면 uncertain, 초과면 unmapped(스팬을 남기지 않는다). */
export const DEFAULT_UNCERTAIN_MAX_RATIO = 0.35;
/** fitting 정렬 DP 셀 수 상한. 넘으면 정확 일치만 시도하고 근사 정렬은 포기한다(too_large). */
export const DEFAULT_MAX_DP_CELLS = 20_000_000;

export type AlignmentReason =
  /** 정규화·trim 뒤 문장이 비어 있다. */
  | 'empty_sentence'
  /** 후보 항목이 없다(C1.11 사유는 SentenceCandidates.reasons에). */
  | 'no_candidates'
  /** 최선의 정렬도 uncertain 상한을 넘는다. */
  | 'over_threshold'
  /** 정확 일치가 없고 DP가 너무 커서 근사 정렬을 건너뛰었다. */
  | 'too_large'
  /** 정확 일치가 후보 안에 둘 이상 있어 어느 것인지 고를 수 없다(uncertain). */
  | 'ambiguous';

export interface SentenceAlignment {
  sentenceId: string;
  status: MappingStatus;
  /** 0~1. 정확·유일 일치는 1, 그 외 1 − 편집 거리 비율(음수는 0). unmapped는 0. */
  confidence: number;
  sourceSpans: SourceSpan[];
  /** 정규화 문자 단위 편집 거리. 정렬하지 못했으면 문장 길이. */
  distance: number;
  /** 정규화·trim한 문장 길이(UTF-16). */
  length: number;
  exact: boolean;
  /** 조립 정규화 문자열 안의 정렬 구간(디버그·통계용). */
  matched?: { start: number; end: number };
  reason?: AlignmentReason;
}

export interface AlignOptions {
  mappedMaxRatio?: number;
  uncertainMaxRatio?: number;
  maxDpCells?: number;
}

interface Piece {
  item: TextItemRecord;
  /** 조립 원문 안에서 이 항목의 str이 차지하는 구간. */
  rawStart: number;
  rawEnd: number;
}

export interface Assembled {
  raw: string;
  pieces: Piece[];
}

/**
 * 후보 항목을 읽기 순서(페이지→index)로 이어 붙인다. 항목 원문은 그대로 두고, 항목 사이에만
 * - 앞 항목이 hasEOL이거나 페이지가 바뀌면 '\n'(정규화기의 줄 끝 하이픈 규칙이 "power-⏎ful"을 잇게 한다),
 * - 같은 페이지에서 index가 건너뛰면 ' '(빠진 항목 자리가 붙어 버리지 않게),
 * - 바로 이어지는 항목이면 아무것도 넣지 않는다(PDF.js는 단어 사이 공백을 별도 항목이나 str 안의 공백으로 낸다).
 */
export function assembleCandidates(items: readonly TextItemRecord[]): Assembled {
  let raw = '';
  const pieces: Piece[] = [];
  let prev: TextItemRecord | undefined;
  for (const item of items) {
    if (prev) {
      if (prev.hasEOL || prev.pageIndex !== item.pageIndex) raw += '\n';
      else if (item.index !== prev.index + 1) raw += ' ';
    }
    const rawStart = raw.length;
    raw += item.str;
    pieces.push({ item, rawStart, rawEnd: raw.length });
    prev = item;
  }
  return { raw, pieces };
}

export interface FittingResult {
  /** 최소 편집 거리. */
  distance: number;
  /** text 안의 정렬 구간 [start, end). */
  start: number;
  end: number;
}

/**
 * query 전체를 text의 어떤 부분 구간에 맞추는 최소 편집 거리(치환·삽입·삭제 1)와 그 구간.
 * 동률이면 짧은 구간(늦은 시작·이른 끝)을 고른다. UTF-16 코드 유닛 단위.
 */
export function fittingAlignment(query: string, text: string): FittingResult {
  const m = query.length;
  const n = text.length;
  if (m === 0) return { distance: 0, start: 0, end: 0 };
  let prev = new Int32Array(n + 1);
  let cur = new Int32Array(n + 1);
  let prevStart = new Int32Array(n + 1);
  let curStart = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) {
    prev[j] = 0;
    prevStart[j] = j;
  }
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    curStart[0] = 0;
    const qc = query.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      // 대각(치환/일치) → 삭제(query 글자 버림) → 삽입(text 글자 건너뜀) 순으로 우선한다.
      let best = prev[j - 1]! + (qc === text.charCodeAt(j - 1) ? 0 : 1);
      let start = prevStart[j - 1]!;
      const del = prev[j]! + 1;
      if (del < best || (del === best && prevStart[j]! > start)) {
        best = del;
        start = prevStart[j]!;
      }
      const ins = cur[j - 1]! + 1;
      if (ins < best || (ins === best && curStart[j - 1]! > start)) {
        best = ins;
        start = curStart[j - 1]!;
      }
      cur[j] = best;
      curStart[j] = start;
    }
    [prev, cur] = [cur, prev];
    [prevStart, curStart] = [curStart, prevStart];
  }
  let bestJ = 0;
  for (let j = 1; j <= n; j++) {
    if (prev[j]! < prev[bestJ]!) bestJ = j;
  }
  return { distance: prev[bestJ]!, start: prevStart[bestJ]!, end: bestJ };
}

/**
 * 문장 정규화 텍스트를 후보 항목 문자열에 정렬해 SourceSpan을 확정한다(PLAN 5.6 2~3항).
 * 항목별 정규화 대응표(`nm_<textItemId>`)는 처음 쓰일 때 만들어 재사용한다(text-items-store와 같은 규칙).
 */
export class SentenceAligner {
  private readonly itemsById = new Map<string, TextItemRecord>();
  private readonly maps = new Map<string, NormalizationMap>();
  private readonly mappedMaxRatio: number;
  private readonly uncertainMaxRatio: number;
  private readonly maxDpCells: number;

  constructor(items: Iterable<TextItemRecord>, opts: AlignOptions = {}) {
    for (const item of items) this.itemsById.set(item.id, item);
    this.mappedMaxRatio = opts.mappedMaxRatio ?? DEFAULT_MAPPED_MAX_RATIO;
    this.uncertainMaxRatio = opts.uncertainMaxRatio ?? DEFAULT_UNCERTAIN_MAX_RATIO;
    this.maxDpCells = opts.maxDpCells ?? DEFAULT_MAX_DP_CELLS;
    if (!(this.mappedMaxRatio >= 0 && this.mappedMaxRatio <= this.uncertainMaxRatio)) {
      throw new Error(
        `0 ≤ mappedMaxRatio ≤ uncertainMaxRatio 이어야 합니다: ${this.mappedMaxRatio}, ${this.uncertainMaxRatio}`,
      );
    }
  }

  private mapOf(item: TextItemRecord): NormalizationMap {
    let map = this.maps.get(item.id);
    if (!map) {
      map = createNormalizationMap(item.str, `nm_${item.id}`).map;
      this.maps.set(item.id, map);
    }
    return map;
  }

  align(
    sentence: Pick<Sentence, 'id' | 'en'>,
    candidates: Pick<SentenceCandidates, 'textItemIds'>,
  ): SentenceAlignment {
    const query = normalizeText(sentence.en).text.trim();
    const length = query.length;
    const fail = (reason: AlignmentReason, distance = length): SentenceAlignment => ({
      sentenceId: sentence.id,
      status: 'unmapped',
      confidence: 0,
      sourceSpans: [],
      distance,
      length,
      exact: false,
      reason,
    });
    if (length === 0) return fail('empty_sentence');

    const items: TextItemRecord[] = [];
    for (const id of candidates.textItemIds) {
      const item = this.itemsById.get(id);
      if (item) items.push(item);
    }
    if (items.length === 0) return fail('no_candidates');

    const assembled = assembleCandidates(items);
    const norm = normalizeText(assembled.raw);
    const asmMap: NormalizationMap = { id: 'assembled', version: '', segments: norm.segments };

    let distance: number;
    let start: number;
    let end: number;
    let exact = false;
    let reason: AlignmentReason | undefined;
    const idx = norm.text.indexOf(query);
    if (idx >= 0) {
      exact = true;
      distance = 0;
      start = idx;
      end = idx + length;
      if (norm.text.indexOf(query, idx + 1) >= 0) reason = 'ambiguous';
    } else {
      if (length * norm.text.length > this.maxDpCells) return fail('too_large');
      const fit = fittingAlignment(query, norm.text);
      distance = fit.distance;
      start = fit.start;
      end = fit.end;
    }

    const ratio = distance / length;
    if (ratio > this.uncertainMaxRatio) return fail('over_threshold', distance);
    let status: MappingStatus = ratio <= this.mappedMaxRatio ? 'mapped' : 'uncertain';
    let confidence = exact ? 1 : Math.max(0, 1 - ratio);
    if (reason === 'ambiguous') {
      status = 'uncertain';
      confidence = Math.min(confidence, 0.5);
    }
    const sourceSpans = this.toSpans(assembled, asmMap, start, end);
    if (sourceSpans.length === 0) return fail('over_threshold', distance);
    const out: SentenceAlignment = {
      sentenceId: sentence.id,
      status,
      confidence,
      sourceSpans,
      distance,
      length,
      exact,
      matched: { start, end },
    };
    if (reason) out.reason = reason;
    return out;
  }

  /** 조립 정규화 구간 → 조립 원문 구간 → 항목 경계에서 잘라 항목별 SourceSpan(항목 대응표 기준 정규화 offset). */
  private toSpans(
    assembled: Assembled,
    asmMap: NormalizationMap,
    normStart: number,
    normEnd: number,
  ): SourceSpan[] {
    const raw = toRawRange(asmMap, normStart, normEnd);
    const spans: SourceSpan[] = [];
    for (const piece of assembled.pieces) {
      const lo = Math.max(raw.start, piece.rawStart);
      const hi = Math.min(raw.end, piece.rawEnd);
      if (hi <= lo) continue;
      const utf16Start = lo - piece.rawStart;
      const utf16End = hi - piece.rawStart;
      const map = this.mapOf(piece.item);
      const n = toNormRange(map, utf16Start, utf16End);
      spans.push({
        pageIndex: piece.item.pageIndex,
        textItemId: piece.item.id,
        utf16Start,
        utf16End,
        normalizedStart: n.start,
        normalizedEnd: n.end,
        normalizationMapId: map.id,
      });
    }
    return spans;
  }
}

export interface AlignmentStats {
  sentences: number;
  byStatus: Record<MappingStatus, number>;
  byReason: Record<AlignmentReason, number>;
  exact: number;
  /** 정렬된 문장(mapped·uncertain)의 편집 거리 비율 분포. */
  ratioMedian: number;
  ratioMax: number;
  /** 정렬된 문장의 스팬 수 분포. */
  spansMedian: number;
  spansMax: number;
}

/** 문장별 정렬 결과의 분포. 추출 경고·커밋 본문 기록용. */
export function alignmentStats(results: readonly SentenceAlignment[]): AlignmentStats {
  const byStatus: Record<MappingStatus, number> = { mapped: 0, uncertain: 0, unmapped: 0 };
  const byReason: Record<AlignmentReason, number> = {
    empty_sentence: 0,
    no_candidates: 0,
    over_threshold: 0,
    too_large: 0,
    ambiguous: 0,
  };
  const ratios: number[] = [];
  const spans: number[] = [];
  let exact = 0;
  for (const r of results) {
    byStatus[r.status]++;
    if (r.reason) byReason[r.reason]++;
    if (r.exact) exact++;
    if (r.status !== 'unmapped') {
      ratios.push(r.length === 0 ? 0 : r.distance / r.length);
      spans.push(r.sourceSpans.length);
    }
  }
  ratios.sort((a, b) => a - b);
  spans.sort((a, b) => a - b);
  const median = (xs: number[]): number => (xs.length === 0 ? 0 : xs[Math.floor(xs.length / 2)]!);
  return {
    sentences: results.length,
    byStatus,
    byReason,
    exact,
    ratioMedian: median(ratios),
    ratioMax: ratios[ratios.length - 1] ?? 0,
    spansMedian: median(spans),
    spansMax: spans[spans.length - 1] ?? 0,
  };
}
