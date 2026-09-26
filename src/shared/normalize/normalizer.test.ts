import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { NormalizationSegment } from '../schema/types';
import {
  createNormalizationMap,
  NORMALIZER_VERSION,
  normalizeText,
  toNormRange,
  toRawRange,
} from './normalizer';

const seg = (
  kind: NormalizationSegment['kind'],
  rawStart: number,
  rawEnd: number,
  normStart: number,
  normEnd: number,
): NormalizationSegment => ({ rawStart, rawEnd, normStart, normEnd, kind });

describe('normalizeText — 규칙별 예시', () => {
  it('합자를 분리 글자로 바꾸고 세그먼트로 기록한다', () => {
    const r = normalizeText('ﬁnancial ﬂow ﬃ');
    expect(r.text).toBe('financial flow ffi');
    expect(r.segments).toEqual([
      seg('ligature', 0, 1, 0, 2),
      seg('copy', 1, 9, 2, 10),
      seg('ligature', 9, 10, 10, 12),
      seg('copy', 10, 13, 12, 15),
      seg('ligature', 13, 14, 15, 18),
    ]);
  });

  it('공백 연속(NBSP·탭·줄바꿈 포함)은 공백 하나로, 앞뒤 공백은 자르지 않는다', () => {
    const r = normalizeText(' a  b\u00A0\t\n c ');
    expect(r.text).toBe(' a b c ');
    // ASCII 공백 하나는 copy에 합쳐진다(' a', 'c ')
    expect(r.segments.map((s) => s.kind)).toEqual(['copy', 'space', 'copy', 'space', 'copy']);
    expect(normalizeText('a b').segments).toEqual([seg('copy', 0, 3, 0, 3)]);
    expect(normalizeText('a\u00A0b').segments.map((s) => s.kind)).toEqual([
      'copy',
      'space',
      'copy',
    ]);
    expect(normalizeText('a\t\u200B\nb').text).toBe('a b');
    expect(normalizeText('a\t\u200B\nb').segments.map((s) => s.kind)).toEqual([
      'copy',
      'space',
      'copy',
    ]);
  });

  it('줄 끝 하이픈: 글자 + 하이픈 + 줄바꿈 + 소문자면 이어 붙인다', () => {
    expect(normalizeText('docu-\nment').text).toBe('document');
    expect(normalizeText('docu-\r\n  ment').text).toBe('document');
    expect(normalizeText('docu\u00AD\nment').text).toBe('document');
    expect(normalizeText('docu\u2010\nment').text).toBe('document');
    expect(normalizeText('docu-\nment').segments).toEqual([
      seg('copy', 0, 4, 0, 4),
      seg('hyphen', 4, 6, 4, 4),
      seg('copy', 6, 10, 4, 8),
    ]);
    // 사전이 없어 복합어도 이어 붙는다(문서화된 한계)
    expect(normalizeText('state-of-the-\nart').text).toBe('state-of-theart');
  });

  it('다음이 대문자·숫자·기호이거나 줄바꿈이 없으면 하이픈을 보존한다', () => {
    expect(normalizeText('COVID-\n19').text).toBe('COVID- 19');
    expect(normalizeText('Wi-\nFi').text).toBe('Wi- Fi');
    expect(normalizeText('x-\n(y)').text).toBe('x- (y)');
    expect(normalizeText('state-of-the-art').text).toBe('state-of-the-art');
    expect(normalizeText('a - b').text).toBe('a - b');
    expect(normalizeText('1-\nb').text).toBe('1- b'); // 앞이 글자가 아님
    expect(normalizeText('-\nb').text).toBe('- b');
    expect(normalizeText('a-').text).toBe('a-');
  });

  it('소프트 하이픈·zero-width·BOM은 버린다', () => {
    const r = normalizeText('a\u00ADb\u200Bc\uFEFF');
    expect(r.text).toBe('abc');
    expect(r.segments.filter((s) => s.kind === 'drop')).toHaveLength(3);
  });

  it('수식 기호·첨자·분수에 NFKC를 적용하지 않는다', () => {
    const raw = '∑ᵢ 𝑥ᵢ ≈ ½ ℝ² ﬁ';
    expect(normalizeText(raw).text).toBe('∑ᵢ 𝑥ᵢ ≈ ½ ℝ² fi');
    expect(raw.normalize('NFKC')).not.toBe(normalizeText(raw).text);
  });

  it('빈 문자열은 빈 결과', () => {
    expect(normalizeText('')).toEqual({ text: '', segments: [] });
    expect(toRawRange({ id: 'x', version: '1', segments: [] }, 0, 0)).toEqual({ start: 0, end: 0 });
  });

  it('createNormalizationMap은 id·version·segments만 담은 map과 텍스트를 돌려준다', () => {
    const { map, text } = createNormalizationMap('ﬁx', 'nm_t_0_1');
    expect(text).toBe('fix');
    expect(map).toEqual({
      id: 'nm_t_0_1',
      version: NORMALIZER_VERSION,
      segments: [seg('ligature', 0, 1, 0, 2), seg('copy', 1, 2, 2, 3)],
    });
    expect(NORMALIZER_VERSION).toBe('1');
  });
});

describe('toRawRange / toNormRange — 예시', () => {
  const raw = 'ab-\ncd  ﬁx';
  const { map, text } = createNormalizationMap(raw, 'nm');
  // text = 'abcd fix'

  it('copy 구간은 1:1', () => {
    expect(text).toBe('abcd fix');
    expect(toRawRange(map, 0, 2)).toEqual({ start: 0, end: 2 });
    expect(toNormRange(map, 0, 2)).toEqual({ start: 0, end: 2 });
  });

  it('폭 0 세그먼트(hyphen)는 구간 안쪽일 때만 포함한다', () => {
    expect(toRawRange(map, 2, 4)).toEqual({ start: 4, end: 6 }); // 'cd'
    expect(toRawRange(map, 1, 3)).toEqual({ start: 1, end: 5 }); // 'b-\nc'
    expect(toRawRange(map, 0, 2)).toEqual({ start: 0, end: 2 }); // 'ab' (하이픈은 경계)
    expect(toNormRange(map, 2, 4)).toEqual({ start: 2, end: 2 }); // '-\n' → 위치 2
  });

  it('공백·합자는 세그먼트 전체로 넓힌다', () => {
    expect(toRawRange(map, 4, 5)).toEqual({ start: 6, end: 8 }); // '  '
    expect(toRawRange(map, 6, 7)).toEqual({ start: 8, end: 9 }); // 'i' → 'ﬁ'
    expect(toNormRange(map, 8, 9)).toEqual({ start: 5, end: 7 }); // 'ﬁ' → 'fi'
    expect(toRawRange(map, 5, 8)).toEqual({ start: 8, end: 10 }); // 'fix' → 'ﬁx'
  });

  it('빈 구간은 copy면 위치 하나, 합자·공백 안이면 세그먼트 전체로 대응한다', () => {
    expect(toRawRange(map, 3, 3)).toEqual({ start: 5, end: 5 });
    expect(toRawRange(map, 8, 8)).toEqual({ start: 10, end: 10 }); // 끝
    expect(toRawRange(map, 6, 6)).toEqual({ start: 8, end: 9 }); // 'f|i' 사이 → 'ﬁ' 전체
    expect(toNormRange(map, 7, 7)).toEqual({ start: 4, end: 5 }); // 공백 연속 안쪽 → ' ' 전체
    expect(() => toRawRange(map, 3, 2)).toThrow(RangeError);
  });
});

// ---------- 속성 기반 테스트 ----------

const ALPHABET = [
  'a',
  'b',
  'c',
  'B',
  'x',
  'é',
  '1',
  '9',
  '.',
  ',',
  '(',
  ')',
  ' ',
  '  ',
  '\n',
  '\r\n',
  '\t',
  '\u00A0',
  '\u2009',
  '-',
  '\u2010',
  '\u00AD',
  '\u200B',
  '\uFEFF',
  'ﬁ',
  'ﬂ',
  'ﬃ',
  'ﬆ',
  '∑',
  '𝑥',
  '≈',
  '½',
  'ᵢ',
];
const rawArb = fc.array(fc.constantFrom(...ALPHABET), { maxLength: 40 }).map((a) => a.join(''));
// 기본 200회. 규칙을 바꿀 때는 FC_NUM_RUNS=3000 정도로 한 번 더 돌린다.
fc.configureGlobal({ numRuns: Number(process.env['FC_NUM_RUNS'] ?? 200) });

describe('normalizeText — 속성', () => {
  it('세그먼트는 원본·정규화 문자열을 빈틈·겹침 없이 순서대로 덮는다', () => {
    fc.assert(
      fc.property(rawArb, (raw) => {
        const { text, segments } = normalizeText(raw);
        let r = 0;
        let n = 0;
        for (const s of segments) {
          expect(s.rawStart).toBe(r);
          expect(s.normStart).toBe(n);
          expect(s.rawEnd).toBeGreaterThanOrEqual(s.rawStart);
          expect(s.normEnd).toBeGreaterThanOrEqual(s.normStart);
          r = s.rawEnd;
          n = s.normEnd;
        }
        expect(r).toBe(raw.length);
        expect(n).toBe(text.length);
      }),
    );
  });

  it('세그먼트 종류마다 폭·내용 규약이 성립한다', () => {
    fc.assert(
      fc.property(rawArb, (raw) => {
        const { text, segments } = normalizeText(raw);
        for (const s of segments) {
          const rawPart = raw.slice(s.rawStart, s.rawEnd);
          const normPart = text.slice(s.normStart, s.normEnd);
          switch (s.kind) {
            case 'copy':
              expect(normPart).toBe(rawPart);
              break;
            case 'ligature':
              expect(rawPart).toHaveLength(1);
              expect(normPart.length).toBeGreaterThanOrEqual(2);
              break;
            case 'space':
              expect(normPart).toBe(' ');
              expect(rawPart).toMatch(/^\s/u);
              expect(rawPart).toMatch(/^(?:\s|\u00AD|\u200B|\u200C|\u200D|\uFEFF)+$/u);
              break;
            case 'hyphen':
            case 'drop':
              expect(normPart).toBe('');
              expect(rawPart.length).toBeGreaterThan(0);
              break;
            case 'insert':
              throw new Error('insert는 현재 규칙에서 나오지 않는다');
          }
        }
      }),
    );
  });

  it('정규화 결과는 고정점이다', () => {
    fc.assert(
      fc.property(rawArb, (raw) => {
        const once = normalizeText(raw).text;
        expect(normalizeText(once).text).toBe(once);
      }),
    );
  });

  it('임의의 정규화 구간을 원본으로 되돌려 다시 정규화하면 그 구간을 포함한다 (denormalize∘normalize)', () => {
    fc.assert(
      fc.property(
        rawArb.chain((raw) => {
          const { text } = normalizeText(raw);
          return fc
            .tuple(fc.nat(text.length), fc.nat(text.length))
            .map(([a, b]) => ({ raw, a: Math.min(a, b), b: Math.max(a, b) }));
        }),
        ({ raw, a, b }) => {
          const { map, text } = createNormalizationMap(raw, 'nm');
          const r = toRawRange(map, a, b);
          expect(r.start).toBeGreaterThanOrEqual(0);
          expect(r.end).toBeLessThanOrEqual(raw.length);
          expect(r.end).toBeGreaterThanOrEqual(r.start);
          const back = normalizeText(raw.slice(r.start, r.end)).text;
          expect(back).toContain(text.slice(a, b));
          // 되돌린 원본 구간의 정규화 구간은 처음 구간을 포함한다
          const n = toNormRange(map, r.start, r.end);
          expect(n.start).toBeLessThanOrEqual(a);
          expect(n.end).toBeGreaterThanOrEqual(b);
        },
      ),
    );
  });

  it('원본 구간 → 정규화 구간 → 원본 구간은 처음 구간을 포함한다', () => {
    fc.assert(
      fc.property(
        rawArb.chain((raw) =>
          fc
            .tuple(fc.nat(raw.length), fc.nat(raw.length))
            .map(([a, b]) => ({ raw, a: Math.min(a, b), b: Math.max(a, b) })),
        ),
        ({ raw, a, b }) => {
          const { map, text } = createNormalizationMap(raw, 'nm');
          const n = toNormRange(map, a, b);
          expect(n.start).toBeGreaterThanOrEqual(0);
          expect(n.end).toBeLessThanOrEqual(text.length);
          const r = toRawRange(map, n.start, n.end);
          // 구간 양끝의 drop·hyphen(정규화 폭 0) 원본 글자는 정규화 문자열에 흔적이 없어
          // 되돌릴 수 없다. 그 부분을 뺀 나머지는 반드시 포함해야 한다.
          const zero = map.segments.filter((s) => s.normStart === s.normEnd);
          let a2 = a;
          let b2 = b;
          for (const s of zero) if (s.rawStart <= a2 && a2 < s.rawEnd) a2 = s.rawEnd;
          for (const s of [...zero].reverse())
            if (s.rawStart < b2 && b2 <= s.rawEnd) b2 = s.rawStart;
          if (a2 >= b2) return;
          expect(r.start).toBeLessThanOrEqual(a2);
          expect(r.end).toBeGreaterThanOrEqual(b2);
        },
      ),
    );
  });
});
