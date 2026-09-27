import { createHash } from 'node:crypto';
import type { MappingStatus, TextItemRecord } from '@shared/schema/types';

/**
 * 정답 매핑 표본(fixtures/truth/mapping.<id>.json)의 형식과 비교 규칙(C1.21, PLAN 12.3).
 *
 * 비교 단위는 "비교 대상 글자(문자·숫자)의 위치 집합"이다. 문장의 정답 스팬과 매핑 결과 스팬이
 * 같은 텍스트 항목의 같은 글자들을 덮으면 일치로 본다. 공백·구두점·하이픈은 비교하지 않는다 —
 * 정답 초안을 영숫자 키 문자열로 찾기 때문에 스팬 양끝의 구두점 위치는 정답이 정하지 못한다.
 */
export const TRUTH_SCHEMA_VERSION = 1;

/**
 * - manual: 자동 초안이 실패해 항목 문자열을 읽고 범위를 직접 정했다.
 * - read: 자동 초안의 스팬 글과 문장 글, 틈(쪽 번호·각주·그림 설명)을 읽어 대조했다.
 * - auto: 문서 전체에서 유일하게 일치한 위치. 읽어서 확인하지 않았다(보조 집계용).
 */
export type TruthVerification = 'manual' | 'read' | 'auto';

export interface TruthEntry {
  /** 문장 order(TEI 정규화 순서) */
  order: number;
  /** sha256(enRaw)의 앞 16자. 문장 분리가 바뀌면 어긋난다. */
  textSha: string;
  /** enRaw 앞부분(사람이 읽기 위한 것, 비교에 쓰지 않음) */
  head: string;
  verification: TruthVerification;
  /** 초안을 찾은 방법: unique | unique_short | repeated_by_order | segmented | manual */
  how: string;
  tags: string[];
  /** `t_3_5:0-52 t_3_7:0-99` — 항목 id와 utf16 범위(끝 미포함) */
  spans: string;
  /** 있어도 없어도 맞는 글자(각주 표시 등). 형식은 spans와 같다. */
  optional?: string;
  note?: string;
}

export interface TruthFile {
  schemaVersion: typeof TRUTH_SCHEMA_VERSION;
  paper: { id: string; arxivVersion: string; sha256: string; pages: number };
  source: { pdfjsVersion: string; items: number; itemsDigest: string };
  parser: { name: string; version: string; teiSha256: string; sentences: number };
  method: string;
  limits: string[];
  entries: TruthEntry[];
}

export interface ItemRange {
  textItemId: string;
  start: number;
  end: number;
}

const SPAN_RE = /^(t_\d+_\d+):(\d+)-(\d+)$/;

export function parseSpans(text: string | undefined): ItemRange[] {
  if (!text) return [];
  return text
    .split(' ')
    .filter((part) => part !== '')
    .map((part) => {
      const m = SPAN_RE.exec(part);
      if (!m) throw new Error(`정답 스팬 형식 오류: ${part}`);
      const range = { textItemId: m[1]!, start: Number(m[2]), end: Number(m[3]) };
      if (range.start >= range.end) throw new Error(`정답 스팬 범위 오류: ${part}`);
      return range;
    });
}

/** 비교 대상 글자: NFKD로 풀었을 때 문자(L)나 숫자(N)가 하나라도 나오는 글자. 정답 생성기와 같은 규칙. */
export function isKeyChar(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch.normalize('NFKD'));
}

/** 범위가 덮는 비교 대상 글자의 위치(`<항목 id>:<utf16 offset>`) 집합 */
export function keyOffsets(
  ranges: readonly ItemRange[],
  strOf: (textItemId: string) => string | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const r of ranges) {
    const str = strOf(r.textItemId);
    if (str === undefined) continue;
    let offset = 0;
    for (const ch of str) {
      if (offset >= r.end) break;
      if (offset >= r.start && isKeyChar(ch)) out.add(`${r.textItemId}:${offset}`);
      offset += ch.length;
    }
  }
  return out;
}

export function textSha(enRaw: string): string {
  return createHash('sha256').update(enRaw, 'utf8').digest('hex').slice(0, 16);
}

/** 텍스트 항목 전체의 지문. 추출기나 PDF.js가 바뀌어 항목 id·문자열이 달라지면 정답이 낡았음을 알린다. */
export function itemsDigest(items: readonly Pick<TextItemRecord, 'id' | 'str'>[]): string {
  const hash = createHash('sha256');
  for (const item of items) hash.update(`${item.id}\t${item.str}\n`, 'utf8');
  return hash.digest('hex');
}

export type SpanVerdict =
  /** 결과가 정답과 같은 글자를 덮는다 */
  | 'equal'
  /** 결과에 정답 글자 일부가 빠졌다 */
  | 'missing'
  /** 결과가 정답 밖 글자를 덮는다 */
  | 'extra'
  /** 빠진 글자도, 정답 밖 글자도 있다 */
  | 'both'
  /** 결과 스팬이 없다(unmapped) */
  | 'no_spans';

export interface SpanComparison {
  verdict: SpanVerdict;
  truth: number;
  missing: number;
  extra: number;
}

export function compareSpans(
  truth: ReadonlySet<string>,
  optional: ReadonlySet<string>,
  predicted: ReadonlySet<string>,
): SpanComparison {
  let missing = 0;
  let extra = 0;
  let size = 0;
  for (const key of truth) {
    if (optional.has(key)) continue;
    size++;
    if (!predicted.has(key)) missing++;
  }
  for (const key of predicted) {
    if (!optional.has(key) && !truth.has(key)) extra++;
  }
  const verdict: SpanVerdict =
    predicted.size === 0
      ? 'no_spans'
      : missing === 0 && extra === 0
        ? 'equal'
        : missing > 0 && extra > 0
          ? 'both'
          : missing > 0
            ? 'missing'
            : 'extra';
  return { verdict, truth: size, missing, extra };
}

export type MappingOutcome =
  /** mapped·uncertain이고 스팬이 정답과 같다 */
  | 'correct'
  /** 스팬이 정답과 다르지만 uncertain·unmapped로 표시되어 사용자에게 경고가 보인다 */
  | 'flagged'
  /** mapped인데 스팬이 정답과 다르다(조용한 오매핑) */
  | 'silent';

export function outcomeOf(status: MappingStatus, verdict: SpanVerdict): MappingOutcome {
  if (verdict === 'equal' && status !== 'unmapped') return 'correct';
  return status === 'mapped' ? 'silent' : 'flagged';
}

/** 범위 안 비교 대상 글자의 위치를 순서대로(선택 흉내용) */
export function keyPositions(
  ranges: readonly ItemRange[],
  strOf: (textItemId: string) => string | undefined,
): { textItemId: string; offset: number; length: number }[] {
  const out: { textItemId: string; offset: number; length: number }[] = [];
  for (const r of ranges) {
    const str = strOf(r.textItemId);
    if (str === undefined) continue;
    let offset = 0;
    for (const ch of str) {
      if (offset >= r.end) break;
      if (offset >= r.start && isKeyChar(ch))
        out.push({ textItemId: r.textItemId, offset, length: ch.length });
      offset += ch.length;
    }
  }
  return out;
}
