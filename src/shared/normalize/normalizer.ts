import type { NormalizationMap, NormalizationSegment } from '../schema/types';

/**
 * 원본 문자열 ↔ 정규화 문자열 대응표 (PLAN 5.4, COMMIT_PLAN C1.9).
 *
 * 규칙(모두 UTF-16 offset 기준, 세그먼트로 역추적 가능):
 * - ligature: 라틴 f-합자(ﬀ ﬁ ﬂ ﬃ ﬄ ﬅ ﬆ) 한 글자 → 분리 글자.
 * - space: 공백 문자(`\s`, NBSP·유니코드 공백·줄바꿈 포함) 연속 → 공백 하나. 앞뒤도 자르지 않는다.
 *   ASCII 공백 하나는 그대로이므로 copy에 합친다.
 * - hyphen: 줄 끝 하이픈 복원. `글자 + ('-' | '\u2010' | U+00AD) + 줄바꿈 포함 공백 + 소문자`이면
 *   하이픈과 공백을 통째로 없앤다(docu-⏎ment → document). 다음 글자가 대문자·숫자·기호이면
 *   하이픈을 보존하고 줄바꿈만 공백으로 바꾼다(COVID-⏎19 → COVID- 19). 사전이 없으므로
 *   `state-of-the-⏎art`도 이어 붙는다(1글자 차이, C1.12 정렬의 편집 거리 허용 범위).
 * - drop: 소프트 하이픈·zero-width·BOM 제거.
 * - copy: 그 외는 그대로. 수식 기호·첨자·분수 등에 NFKC를 적용하지 않는다.
 *
 * 정규화 결과는 고정점이다: normalizeText(text).text === text.
 * 대응표는 PDF.js 텍스트 항목 하나(str)를 단위로 만든다. 항목 사이의 줄 끝 하이픈(hasEOL)은
 * 페이지 문자열을 조립하는 C1.12에서 다룬다. 규칙이 바뀌면 NORMALIZER_VERSION을 올린다.
 */
export const NORMALIZER_VERSION = '1';

const LIGATURES: Readonly<Record<string, string>> = {
  ﬀ: 'ff',
  ﬁ: 'fi',
  ﬂ: 'fl',
  ﬃ: 'ffi',
  ﬄ: 'ffl',
  ﬅ: 'ft',
  ﬆ: 'st',
};
// 결합 문자(ZWJ·ZWNJ)를 문자 클래스에 넣으면 eslint가 경고하므로 선택으로 쓴다.
const DROP_RE = /^(?:\u00AD|\u200B|\u200C|\u200D|\uFEFF)$/u;
const SPACE_RE = /^\s$/u;
const LINE_BREAK_RE = /[\n\r\u2028\u2029]/u;
const LETTER_RE = /^\p{L}$/u;
const LOWER_RE = /^\p{Ll}$/u;
const HYPHEN_CHARS = new Set(['-', '\u2010', '\u00AD']);

export interface NormalizedText {
  text: string;
  segments: NormalizationSegment[];
}

/** i 앞에 있는 마지막 non-drop 코드 포인트(문자열). 없으면 ''. */
function charBefore(raw: string, i: number): string {
  let j = i;
  while (j > 0) {
    let k = j - 1;
    const low = raw.charCodeAt(k);
    if (low >= 0xdc00 && low <= 0xdfff && k > 0) k--;
    const ch = String.fromCodePoint(raw.codePointAt(k)!);
    if (!DROP_RE.test(ch)) return ch;
    j = k;
  }
  return '';
}

const isSpaceOrDrop = (ch: string): boolean => SPACE_RE.test(ch) || DROP_RE.test(ch);

function charAt(raw: string, i: number): string {
  const cp = raw.codePointAt(i);
  return cp === undefined ? '' : String.fromCodePoint(cp);
}

export function normalizeText(raw: string): NormalizedText {
  const segments: NormalizationSegment[] = [];
  let text = '';
  let i = 0;

  const push = (kind: NormalizationSegment['kind'], rawEnd: number, out: string): void => {
    const last = segments[segments.length - 1];
    if (kind === 'copy' && last?.kind === 'copy' && last.rawEnd === i) {
      last.rawEnd = rawEnd;
      last.normEnd += out.length;
    } else {
      segments.push({
        rawStart: i,
        rawEnd,
        normStart: text.length,
        normEnd: text.length + out.length,
        kind,
      });
    }
    text += out;
    i = rawEnd;
  };

  while (i < raw.length) {
    const ch = charAt(raw, i);
    const lig = LIGATURES[ch];
    if (lig !== undefined) {
      push('ligature', i + ch.length, lig);
      continue;
    }
    if (HYPHEN_CHARS.has(ch)) {
      // 줄 끝 하이픈: 뒤따르는 공백 연속에 줄바꿈이 있고, 앞은 글자·뒤는 소문자일 때만 잇는다.
      let j = i + 1;
      while (j < raw.length && isSpaceOrDrop(charAt(raw, j))) j += charAt(raw, j).length;
      const ws = raw.slice(i + 1, j);
      if (
        ws !== '' &&
        LINE_BREAK_RE.test(ws) &&
        LETTER_RE.test(charBefore(raw, i)) &&
        LOWER_RE.test(charAt(raw, j))
      ) {
        push('hyphen', j, '');
        continue;
      }
      if (ch === '\u00AD') {
        push('drop', i + 1, '');
        continue;
      }
      push('copy', i + 1, ch);
      continue;
    }
    if (DROP_RE.test(ch)) {
      push('drop', i + ch.length, '');
      continue;
    }
    if (SPACE_RE.test(ch)) {
      // 공백 연속 안에 섞인 drop 문자(zero-width 등)도 같은 세그먼트에 흡수한다.
      // 그래야 정규화 결과가 고정점이 된다("\t\u200B\n" → " ").
      let j = i;
      while (j < raw.length && isSpaceOrDrop(charAt(raw, j))) j += charAt(raw, j).length;
      // 공백 하나(ASCII)는 바뀌지 않으므로 copy로 합친다. 실제 PDF.js 항목은 대부분 이 경우라
      // 대응표가 항목당 세그먼트 하나로 줄어든다.
      if (j === i + 1 && ch === ' ') push('copy', j, ' ');
      else push('space', j, ' ');
      continue;
    }
    push('copy', i + ch.length, ch);
  }
  return { text, segments };
}

export function createNormalizationMap(
  raw: string,
  id: string,
): { map: NormalizationMap; text: string } {
  const { text, segments } = normalizeText(raw);
  return { map: { id, version: NORMALIZER_VERSION, segments }, text };
}

export interface Range {
  start: number;
  end: number;
}

/**
 * 정규화 offset 구간 [normStart, normEnd)을 덮는 최소 원본 구간.
 * copy 세그먼트는 1:1로 자르고, 그 외는 세그먼트 전체를 포함한다. 폭 0 세그먼트(drop·hyphen)는
 * 구간 경계가 아니라 안쪽에 있을 때만 포함한다. 빈 구간은 copy 안이면 위치 하나로, 합자·공백
 * 안이면 그 세그먼트 전체로 대응한다(글자 하나를 쪼갤 수 없으므로).
 */
export function toRawRange(map: NormalizationMap, normStart: number, normEnd: number): Range {
  return project(map.segments, normStart, normEnd, 'norm');
}

/** 원본 offset 구간 [rawStart, rawEnd)에 대응하는 정규화 구간. toRawRange의 반대 방향. */
export function toNormRange(map: NormalizationMap, rawStart: number, rawEnd: number): Range {
  return project(map.segments, rawStart, rawEnd, 'raw');
}

function project(
  segments: NormalizationSegment[],
  from: number,
  to: number,
  side: 'norm' | 'raw',
): Range {
  if (to < from) throw new RangeError(`구간이 뒤집혔습니다: [${from}, ${to})`);
  const src = (s: NormalizationSegment): Range =>
    side === 'norm' ? { start: s.normStart, end: s.normEnd } : { start: s.rawStart, end: s.rawEnd };
  const dst = (s: NormalizationSegment): Range =>
    side === 'norm' ? { start: s.rawStart, end: s.rawEnd } : { start: s.normStart, end: s.normEnd };

  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const seg of segments) {
    const s = src(seg);
    const d = dst(seg);
    const zeroWidth = s.start === s.end;
    const included = zeroWidth
      ? from < s.start && s.start < to
      : from === to
        ? s.start <= from && from < s.end
        : s.start < to && s.end > from;
    if (!included) continue;
    if (seg.kind === 'copy') {
      const a = Math.max(from, s.start) - s.start;
      const b = Math.min(to, s.end) - s.start;
      start = Math.min(start, d.start + a);
      end = Math.max(end, d.start + b);
    } else {
      start = Math.min(start, d.start);
      end = Math.max(end, d.end);
    }
  }
  if (!Number.isFinite(start)) {
    // 세그먼트 밖(빈 문자열이거나 끝 위치): 마지막 세그먼트의 끝으로 맞춘다.
    const last = segments[segments.length - 1];
    const p = last ? dst(last).end : 0;
    return { start: p, end: p };
  }
  return { start, end };
}
