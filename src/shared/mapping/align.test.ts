import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalizeText } from '../normalize/normalizer';
import type { TextItemRecord } from '../schema/types';
import {
  ALIGNMENT_VERSION,
  DEFAULT_MAPPED_MAX_RATIO,
  DEFAULT_UNCERTAIN_MAX_RATIO,
  SentenceAligner,
  alignmentStats,
  assembleCandidates,
  fittingAlignment,
} from './align';

function item(pageIndex: number, index: number, str: string, hasEOL = false): TextItemRecord {
  return {
    id: `t_${pageIndex}_${index}`,
    pageIndex,
    index,
    str,
    transform: [10, 0, 0, 10, 0, 0],
    width: str.length * 5,
    height: 10,
    fontName: 'f',
    dir: 'ltr',
    hasEOL,
  };
}

const ids = (items: TextItemRecord[]): { textItemIds: string[] } => ({
  textItemIds: items.map((i) => i.id),
});

describe('assembleCandidates', () => {
  it('바로 이어지는 항목은 그대로 붙이고 hasEOL·페이지 경계는 줄바꿈, index 건너뜀은 공백', () => {
    const items = [
      item(0, 0, 'Hello'),
      item(0, 1, ' world', true),
      item(0, 3, 'skipped'),
      item(1, 0, 'next'),
    ];
    const { raw, pieces } = assembleCandidates(items);
    expect(raw).toBe('Hello world\nskipped\nnext');
    expect(pieces.map((p) => [p.rawStart, p.rawEnd])).toEqual([
      [0, 5],
      [5, 11],
      [12, 19],
      [20, 24],
    ]);
    expect(assembleCandidates([]).raw).toBe('');
  });
});

describe('fittingAlignment', () => {
  it('정확 부분 문자열은 거리 0, 그 구간', () => {
    expect(fittingAlignment('world', 'hello world!')).toEqual({ distance: 0, start: 6, end: 11 });
    expect(fittingAlignment('', 'abc')).toEqual({ distance: 0, start: 0, end: 0 });
    expect(fittingAlignment('abc', '')).toEqual({ distance: 3, start: 0, end: 0 });
  });

  it('하이픈 삽입·글자 치환은 거리 1', () => {
    expect(fittingAlignment('knowledgeintensive', 'for knowledge-intensive tasks')).toEqual({
      distance: 1,
      start: 4,
      end: 23,
    });
    expect(fittingAlignment('colour', 'the color of')).toEqual({ distance: 1, start: 4, end: 9 });
  });

  /** 무차별: 모든 부분 구간에 대한 Levenshtein 최소. */
  function brute(query: string, text: string): number {
    const lev = (a: string, b: string): number => {
      const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
      for (let j = 1; j <= b.length; j++) d[0]![j] = j;
      for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++)
          d[i]![j] = Math.min(
            d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
            d[i - 1]![j]! + 1,
            d[i]![j - 1]! + 1,
          );
      return d[a.length]![b.length]!;
    };
    let best = query.length;
    for (let s = 0; s <= text.length; s++)
      for (let e = s; e <= text.length; e++) best = Math.min(best, lev(query, text.slice(s, e)));
    return best;
  }

  it('속성: 최소 거리는 모든 부분 구간 Levenshtein의 최소와 같고, 구간의 거리도 그 값이다', () => {
    const alpha = fc.stringMatching(/^[ab -]{0,10}$/);
    fc.assert(
      fc.property(alpha, alpha, (q, t) => {
        const r = fittingAlignment(q, t);
        expect(r.distance).toBe(brute(q, t));
        expect(r.start).toBeLessThanOrEqual(r.end);
        expect(r.end).toBeLessThanOrEqual(t.length);
        // 고른 구간 자체의 Levenshtein 거리도 최소값
        expect(brute(q, t.slice(r.start, r.end))).toBeGreaterThanOrEqual(r.distance);
        expect(fittingAlignment(q, t.slice(r.start, r.end)).distance).toBe(r.distance);
      }),
      { numRuns: Number(process.env['FC_NUM_RUNS'] ?? 300) },
    );
  });
});

describe('SentenceAligner', () => {
  it('단일 항목 정확 일치: mapped, 확신 1, 항목 offset', () => {
    const items = [item(0, 0, 'Before. The quick fox. After.')];
    const r = new SentenceAligner(items).align({ id: 's', en: 'The quick fox.' }, ids(items));
    expect(r.status).toBe('mapped');
    expect(r.confidence).toBe(1);
    expect(r.exact).toBe(true);
    expect(r.distance).toBe(0);
    expect(r.reason).toBeUndefined();
    expect(r.sourceSpans).toEqual([
      {
        pageIndex: 0,
        textItemId: 't_0_0',
        utf16Start: 8,
        utf16End: 22,
        normalizedStart: 8,
        normalizedEnd: 22,
        normalizationMapId: 'nm_t_0_0',
      },
    ]);
  });

  it('여러 항목(공백 항목 포함)에 걸친 문장은 항목 경계에서 스팬을 나눈다', () => {
    const items = [
      item(0, 0, 'tail. The'),
      item(0, 1, ' '),
      item(0, 2, 'quick'),
      item(0, 3, ' fox. Next'),
    ];
    const r = new SentenceAligner(items).align({ id: 's', en: 'The quick fox.' }, ids(items));
    expect(r.status).toBe('mapped');
    expect(r.sourceSpans.map((s) => [s.textItemId, s.utf16Start, s.utf16End])).toEqual([
      ['t_0_0', 6, 9],
      ['t_0_1', 0, 1],
      ['t_0_2', 0, 5],
      ['t_0_3', 0, 5],
    ]);
  });

  it('줄 끝 하이픈: 항목 "power-"(hasEOL)+"ful"은 정확 일치이고 첫 스팬이 하이픈까지 덮는다', () => {
    const items = [item(0, 0, 'It is power-', true), item(0, 1, 'ful text.')];
    const r = new SentenceAligner(items).align({ id: 's', en: 'It is powerful text.' }, ids(items));
    expect(r.exact).toBe(true);
    expect(r.status).toBe('mapped');
    expect(
      r.sourceSpans.map((s) => [
        s.textItemId,
        s.utf16Start,
        s.utf16End,
        s.normalizedStart,
        s.normalizedEnd,
      ]),
    ).toEqual([
      ['t_0_0', 0, 12, 0, 12],
      ['t_0_1', 0, 9, 0, 9],
    ]);
  });

  it('GROBID가 하이픈을 지운 결합어는 거리 1로 mapped', () => {
    const items = [item(0, 0, 'for knowledge-intensive tasks.')];
    const r = new SentenceAligner(items).align(
      { id: 's', en: 'for knowledgeintensive tasks.' },
      ids(items),
    );
    expect(r.exact).toBe(false);
    expect(r.distance).toBe(1);
    expect(r.status).toBe('mapped');
    expect(r.confidence).toBeCloseTo(1 - 1 / 29, 6);
    expect(r.sourceSpans).toEqual([
      expect.objectContaining({ textItemId: 't_0_0', utf16Start: 0, utf16End: 30 }),
    ]);
  });

  it('합자·연속 공백은 정규화로 흡수되고 스팬은 원본·정규화 offset을 따로 갖는다', () => {
    const items = [item(0, 0, 'x  ﬁnd it')];
    const r = new SentenceAligner(items).align({ id: 's', en: 'find it' }, ids(items));
    expect(r.exact).toBe(true);
    expect(r.sourceSpans).toEqual([
      expect.objectContaining({
        utf16Start: 3,
        utf16End: 9,
        normalizedStart: 2,
        normalizedEnd: 9,
      }),
    ]);
  });

  it('페이지 경계·index 건너뜀을 넘는 문장', () => {
    const items = [item(0, 7, 'the end of'), item(1, 0, 'the'), item(1, 2, 'page.')];
    const r = new SentenceAligner(items).align({ id: 's', en: 'the end of the page.' }, ids(items));
    expect(r.exact).toBe(true);
    expect(r.sourceSpans.map((s) => s.pageIndex)).toEqual([0, 1, 1]);
  });

  it('빈 문장·후보 없음·전혀 다른 텍스트는 unmapped이며 스팬이 없다', () => {
    const items = [item(0, 0, 'Completely different words here.')];
    const a = new SentenceAligner(items);
    expect(a.align({ id: 's', en: '  \n ' }, ids(items))).toMatchObject({
      status: 'unmapped',
      reason: 'empty_sentence',
      sourceSpans: [],
      confidence: 0,
    });
    expect(a.align({ id: 's', en: 'text' }, { textItemIds: ['missing'] })).toMatchObject({
      status: 'unmapped',
      reason: 'no_candidates',
      distance: 4,
    });
    const far = a.align({ id: 's', en: 'The quick brown fox jumps.' }, ids(items));
    expect(far.status).toBe('unmapped');
    expect(far.reason).toBe('over_threshold');
    expect(far.sourceSpans).toEqual([]);
    expect(far.distance / far.length).toBeGreaterThan(DEFAULT_UNCERTAIN_MAX_RATIO);
  });

  it('후보 범위 밖의 정확 일치는 쓰지 않는다', () => {
    const exact = item(0, 0, 'The quick fox.');
    const other = item(0, 5, 'Unrelated sentence body.');
    const r = new SentenceAligner([exact, other]).align(
      { id: 's', en: 'The quick fox.' },
      { textItemIds: [other.id] },
    );
    expect(r.status).toBe('unmapped');
    expect(r.sourceSpans).toEqual([]);
  });

  it('후보 안에 정확 일치가 둘이면 uncertain(ambiguous), 첫 위치를 쓴다', () => {
    const items = [item(0, 0, 'where x. and where x.')];
    const r = new SentenceAligner(items).align({ id: 's', en: 'where x.' }, ids(items));
    expect(r.status).toBe('uncertain');
    expect(r.reason).toBe('ambiguous');
    expect(r.confidence).toBe(0.5);
    expect(r.sourceSpans[0]).toMatchObject({ utf16Start: 0, utf16End: 8 });
  });

  it('편집 거리 비율이 mapped 상한을 넘으면 uncertain', () => {
    const items = [item(0, 0, 'aaaa bbbb cccc dddd')];
    const r = new SentenceAligner(items).align({ id: 's', en: 'aaaa bbXX cccc XXdd' }, ids(items));
    expect(r.distance).toBe(4);
    expect(r.distance / r.length).toBeGreaterThan(DEFAULT_MAPPED_MAX_RATIO);
    expect(r.status).toBe('uncertain');
    expect(r.confidence).toBeCloseTo(1 - 4 / 19, 6);
    expect(r.sourceSpans).toHaveLength(1);
  });

  it('DP 상한을 넘으면 정확 일치만 시도한다(too_large)', () => {
    const items = [item(0, 0, 'for knowledge-intensive tasks.')];
    const a = new SentenceAligner(items, { maxDpCells: 10 });
    expect(a.align({ id: 's', en: 'knowledgeintensive' }, ids(items)).reason).toBe('too_large');
    expect(a.align({ id: 's', en: 'knowledge-intensive' }, ids(items)).status).toBe('mapped');
  });

  it('잘못된 임계값은 거부한다', () => {
    expect(
      () => new SentenceAligner([], { mappedMaxRatio: 0.5, uncertainMaxRatio: 0.2 }),
    ).toThrow();
    expect(() => new SentenceAligner([], { mappedMaxRatio: -1 })).toThrow();
    expect(ALIGNMENT_VERSION).toBe('1');
  });

  it('속성: 조립 정규화 텍스트의 임의 구간은 정확히 정렬되고 스팬은 항목 범위 안·순서대로', () => {
    const word = fc.stringMatching(/^[a-zA-Z ﬁ-]{1,8}$/);
    const itemsArb = fc
      .array(fc.tuple(word, fc.boolean()), { minLength: 1, maxLength: 6 })
      .map((xs) => xs.map(([s, eol], i) => item(0, i, s, eol)));
    fc.assert(
      fc.property(itemsArb, fc.nat(), fc.nat(), (items, a, b) => {
        const { raw } = assembleCandidates(items);
        const text = normalizeText(raw).text;
        if (text.length === 0) return;
        const s = a % text.length;
        const e = s + 1 + (b % (text.length - s));
        const en = text.slice(s, e);
        if (en.trim() === '') return;
        const r = new SentenceAligner(items).align({ id: 's', en }, ids(items));
        expect(r.exact).toBe(true);
        expect(r.distance).toBe(0);
        expect(['mapped', 'uncertain']).toContain(r.status);
        expect(r.sourceSpans.length).toBeGreaterThan(0);
        let prevIndex = -1;
        for (const sp of r.sourceSpans) {
          const it = items[Number(sp.textItemId.split('_')[2])]!;
          expect(it.index).toBeGreaterThan(prevIndex);
          prevIndex = it.index;
          expect(sp.utf16Start).toBeGreaterThanOrEqual(0);
          expect(sp.utf16Start).toBeLessThan(sp.utf16End);
          expect(sp.utf16End).toBeLessThanOrEqual(it.str.length);
          const normLen = normalizeText(it.str).text.length;
          expect(sp.normalizedStart).toBeLessThanOrEqual(sp.normalizedEnd);
          expect(sp.normalizedEnd).toBeLessThanOrEqual(normLen);
        }
      }),
      { numRuns: Number(process.env['FC_NUM_RUNS'] ?? 300) },
    );
  });
});

describe('alignmentStats', () => {
  it('상태·사유·비율·스팬 수 분포를 집계한다', () => {
    const items = [item(0, 0, 'The quick fox. for knowledge-intensive tasks.')];
    const a = new SentenceAligner(items);
    const results = [
      a.align({ id: '1', en: 'The quick fox.' }, ids(items)),
      a.align({ id: '2', en: 'for knowledgeintensive tasks.' }, ids(items)),
      a.align({ id: '3', en: '' }, ids(items)),
    ];
    const st = alignmentStats(results);
    expect(st.sentences).toBe(3);
    expect(st.byStatus).toEqual({ mapped: 2, uncertain: 0, unmapped: 1 });
    expect(st.byReason.empty_sentence).toBe(1);
    expect(st.exact).toBe(1);
    expect(st.ratioMedian).toBeCloseTo(1 / 29, 6);
    expect(st.ratioMax).toBeCloseTo(1 / 29, 6);
    expect(st.spansMedian).toBe(1);
    expect(st.spansMax).toBe(1);
    expect(alignmentStats([]).ratioMax).toBe(0);
  });
});
