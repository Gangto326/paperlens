import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Rect } from '../schema/types';
import {
  SentenceLookup,
  type SentenceIndex,
  type SentenceIndexEntry,
  type TextRange,
} from './selection';

const rect = (pageIndex: number, x: number, y: number, w: number, h: number): Rect => ({
  pageIndex,
  x,
  y,
  width: w,
  height: h,
  coordinateSpace: 'pdf_user_space',
  transformVersion: '1',
});

function sentence(
  id: string,
  order: number,
  spans: [string, number, number][],
  rects: Rect[] = [],
  mappingStatus: SentenceIndexEntry['mappingStatus'] = 'mapped',
): SentenceIndexEntry {
  return {
    id,
    order,
    page: 0,
    pages: [0],
    sectionId: 'sec_1',
    paragraphId: 'p_1',
    en: id,
    mappingStatus,
    mappingConfidence: 1,
    sourceSpans: spans.map(([textItemId, utf16Start, utf16End]) => ({
      pageIndex: Number(textItemId.split('_')[1]),
      textItemId,
      utf16Start,
      utf16End,
      normalizedStart: utf16Start,
      normalizedEnd: utf16End,
      normalizationMapId: `nm_${textItemId}`,
    })),
    rects,
    equations: [],
    warnings: [],
  };
}

const range = (
  textItemId: string,
  start: number,
  end: number,
  text = 'x'.repeat(end - start),
): TextRange => ({
  textItemId,
  start,
  end,
  text,
});

/**
 * 항목 t_0_0 = "First one. Second"  (0..10 = s1, 11..17 = s2 시작)
 * 항목 t_0_1 = "continues here."   (s2 계속, 줄바꿈 뒤)
 * 항목 t_1_0 = "Third on page two." (s3, 페이지 경계)
 * s4는 미연결(스팬 없음, 사각형만), 제외 블록 x1은 1쪽 위쪽.
 */
function index(): SentenceIndex {
  return {
    extractionRevision: 'r',
    pages: [],
    sentences: [
      sentence('s3', 3, [['t_1_0', 0, 18]], [rect(1, 50, 600, 200, 12)]),
      sentence('s1', 1, [['t_0_0', 0, 10]], [rect(0, 50, 700, 100, 12)]),
      sentence(
        's2',
        2,
        [
          ['t_0_0', 11, 17],
          ['t_0_1', 0, 15],
        ],
        [rect(0, 150, 700, 60, 12), rect(0, 50, 688, 120, 12)],
      ),
      sentence('s4', 4, [], [rect(1, 50, 500, 200, 12)], 'unmapped'),
    ],
    excludedBlocks: [{ id: 'x1', type: 'formula', rects: [rect(1, 50, 700, 200, 40)] }],
  };
}

describe('SentenceLookup.resolveRanges (드래그)', () => {
  const lookup = new SentenceLookup(index());

  it('부분 드래그가 전체 문장으로 확장된다', () => {
    const r = lookup.resolveRanges([range('t_0_0', 2, 5)]);
    expect(r.reason).toBe('ok');
    expect(r.sentences.map((s) => s.id)).toEqual(['s1']);
  });

  it('두 문장에 걸친 드래그는 본문 순서로, 여러 줄(항목)·페이지 경계도 순서대로', () => {
    const r = lookup.resolveRanges([
      range('t_1_0', 0, 5),
      range('t_0_0', 8, 17),
      range('t_0_1', 0, 3),
    ]);
    expect(r.sentences.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('같은 문장이 여러 범위에 걸려도 한 번만 나온다', () => {
    const r = lookup.resolveRanges([range('t_0_0', 12, 17), range('t_0_1', 1, 4)]);
    expect(r.sentences.map((s) => s.id)).toEqual(['s2']);
  });

  it('공백만 선택하면 빈 결과(다른 문장을 대신 보여주지 않는다)', () => {
    const r = lookup.resolveRanges([range('t_0_0', 10, 11, ' ')]);
    expect(r).toEqual({ sentences: [], reason: 'whitespace_only', byRect: false });
  });

  it('스팬 밖 글자(제외 블록·미연결 문장)만 드래그하면 no_sentence', () => {
    expect(lookup.resolveRanges([range('t_9_9', 0, 3)]).reason).toBe('no_sentence');
    expect(lookup.resolveRanges([]).reason).toBe('empty_selection');
  });

  it('스팬과 닿기만 하고 겹치지 않는 범위는 잡히지 않는다(반열림 구간)', () => {
    // t_0_0의 10..11은 공백이 아닌 글자라고 가정해도 s1(0..10)·s2(11..17) 어느 쪽과도 겹치지 않는다.
    const r = lookup.resolveRanges([range('t_0_0', 10, 11, '.')]);
    expect(r.reason).toBe('no_sentence');
  });

  it('caret 범위만 있으면 클릭으로 해석한다', () => {
    const r = lookup.resolveRanges([range('t_0_0', 3, 3, '')]);
    expect(r.sentences.map((s) => s.id)).toEqual(['s1']);
  });
});

describe('SentenceLookup.resolveCaret (클릭)', () => {
  const lookup = new SentenceLookup(index());

  it('caret이 든 스팬의 문장을 하나 돌려준다', () => {
    expect(lookup.resolveCaret({ textItemId: 't_0_0', offset: 12 }).sentences[0]?.id).toBe('s2');
    expect(lookup.resolveCaret({ textItemId: 't_0_1', offset: 0 }).sentences[0]?.id).toBe('s2');
  });

  it('두 스팬의 경계에서는 뒤 스팬(시작이 가장 가까운 것)을 고른다', () => {
    const idx = index();
    idx.sentences.push(sentence('s5', 5, [['t_0_0', 10, 17]]));
    const l = new SentenceLookup(idx);
    // offset 10: s1은 [0,10)이라 끝에만 닿고 s5는 [10,17)이 덮는다 → s5.
    expect(l.resolveCaret({ textItemId: 't_0_0', offset: 10 }).sentences[0]?.id).toBe('s5');
    // offset 11: s2 [11,17)·s5 [10,17) 둘 다 덮는다 → 시작이 더 가까운 s2.
    expect(l.resolveCaret({ textItemId: 't_0_0', offset: 11 }).sentences[0]?.id).toBe('s2');
  });

  it('스팬 끝에만 닿은 caret(줄 끝 클릭)은 그 스팬을 쓴다', () => {
    expect(lookup.resolveCaret({ textItemId: 't_0_0', offset: 10 }).sentences[0]?.id).toBe('s1');
    expect(lookup.resolveCaret({ textItemId: 't_0_1', offset: 15 }).sentences[0]?.id).toBe('s2');
  });

  it('스팬이 없고 지점도 없으면 no_sentence', () => {
    expect(lookup.resolveCaret({ textItemId: 't_1_5', offset: 0 })).toEqual({
      sentences: [],
      reason: 'no_sentence',
      byRect: false,
    });
  });

  it('스팬이 없으면 지점으로 문장 사각형을 찾는다(미연결 문장도 찾는다, byRect)', () => {
    const r = lookup.resolveCaret(
      { textItemId: 't_1_5', offset: 0 },
      { pageIndex: 1, x: 60, y: 505 },
    );
    expect(r.byRect).toBe(true);
    expect(r.sentences[0]?.id).toBe('s4');
    expect(r.sentences[0]?.mappingStatus).toBe('unmapped');
  });

  it('지점이 제외 블록 안이면 다른 문장을 대신 보여주지 않는다', () => {
    const r = lookup.resolvePoint({ pageIndex: 1, x: 60, y: 720 });
    expect(r).toEqual({ sentences: [], reason: 'excluded_block', byRect: true });
  });

  it('사각형이 겹치면 가장 작은 것', () => {
    const idx = index();
    idx.sentences.push(sentence('big', 9, [], [rect(0, 0, 0, 1000, 1000)]));
    const l = new SentenceLookup(idx);
    expect(l.resolvePoint({ pageIndex: 0, x: 60, y: 705 }).sentences[0]?.id).toBe('s1');
    expect(l.resolvePoint({ pageIndex: 0, x: 900, y: 900 }).sentences[0]?.id).toBe('big');
    expect(l.resolvePoint({ pageIndex: 2, x: 1, y: 1 }).reason).toBe('no_sentence');
  });
});

describe('빈 범위 여러 개', () => {
  it('각 caret의 문장을 order 순으로 모으고 범위 순서와 무관하다', () => {
    // fast-check가 찾은 반례(seed -1449580875): 빈 범위 두 개가 서로 다른 문장에 놓인 경우.
    const lookup = new SentenceLookup(index());
    const a = lookup.resolveRanges([range('t_0_0', 15, 15), range('t_0_0', 1, 1)]);
    const b = lookup.resolveRanges([range('t_0_0', 1, 1), range('t_0_0', 15, 15)]);
    expect(a.sentences.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(b).toEqual(a);
    expect(lookup.resolveRanges([range('t_0_0', 15, 15)]).sentences.map((s) => s.id)).toEqual([
      's2',
    ]);
  });
});

describe('속성', () => {
  it('드래그 결과는 항상 order 오름차순·중복 없음이며, 범위 순서와 무관하다', () => {
    const lookup = new SentenceLookup(index());
    const items = ['t_0_0', 't_0_1', 't_1_0', 't_9_9'];
    const arbRange = fc
      .record({
        i: fc.integer({ min: 0, max: items.length - 1 }),
        a: fc.integer({ min: 0, max: 18 }),
        b: fc.integer({ min: 0, max: 18 }),
      })
      .map(({ i, a, b }) => range(items[i]!, Math.min(a, b), Math.max(a, b)));
    fc.assert(
      fc.property(fc.array(arbRange, { minLength: 1, maxLength: 6 }), (ranges) => {
        const r = lookup.resolveRanges(ranges);
        const orders = r.sentences.map((s) => s.order);
        expect(orders).toEqual([...orders].sort((x, y) => x - y));
        expect(new Set(r.sentences.map((s) => s.id)).size).toBe(r.sentences.length);
        const shuffled = lookup.resolveRanges([...ranges].reverse());
        expect(shuffled.sentences.map((s) => s.id)).toEqual(r.sentences.map((s) => s.id));
      }),
    );
  });
});
