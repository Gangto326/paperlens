import { describe, expect, it } from 'vitest';
import type { SentenceIndexEntry } from '@shared/mapping/selection';
import {
  PENDING_TRANSLATION,
  UNCERTAIN_NOTICE,
  UNMAPPED_NOTICE,
  selectionView,
  splitEquations,
} from './selection-view';

const entry = (
  id: string,
  order: number,
  en: string,
  mappingStatus: SentenceIndexEntry['mappingStatus'] = 'mapped',
): SentenceIndexEntry => ({
  id,
  order,
  page: 2,
  pages: [2],
  sectionId: 'sec_1',
  paragraphId: 'p_1',
  en,
  mappingStatus,
  mappingConfidence: 1,
  sourceSpans: [],
  rects: [],
  equations: [],
  warnings: [],
});

describe('splitEquations', () => {
  it('[EQ_n] 토큰을 조각으로 분리한다', () => {
    expect(splitEquations('Let [EQ_1] be the loss and [EQ_2].')).toEqual([
      { kind: 'text', text: 'Let ' },
      { kind: 'equation', text: '[EQ_1]' },
      { kind: 'text', text: ' be the loss and ' },
      { kind: 'equation', text: '[EQ_2]' },
      { kind: 'text', text: '.' },
    ]);
    expect(splitEquations('[EQ_3]')).toEqual([{ kind: 'equation', text: '[EQ_3]' }]);
    expect(splitEquations('plain')).toEqual([{ kind: 'text', text: 'plain' }]);
    expect(splitEquations('')).toEqual([{ kind: 'text', text: '' }]);
  });
});

describe('selectionView', () => {
  it('원문·순번·쪽·상태와 처리 대기 문구를 만든다', () => {
    const v = selectionView({
      sentences: [entry('s1', 12, 'Hello world.')],
      reason: 'ok',
      byRect: false,
    });
    expect(v.summary).toBe('문장 1개 선택');
    expect(v.sentences[0]).toMatchObject({
      id: 's1',
      label: '#12 · 3쪽',
      statusLabel: '연결됨',
      notice: null,
      translation: PENDING_TRANSLATION,
    });
  });

  it('unmapped는 "연결을 확인하지 못했습니다", uncertain은 불확실 안내를 붙이고 머리글에 집계한다', () => {
    const v = selectionView({
      sentences: [
        entry('a', 1, 'x', 'unmapped'),
        entry('b', 2, 'y', 'uncertain'),
        entry('c', 3, 'z'),
      ],
      reason: 'ok',
      byRect: true,
    });
    expect(v.summary).toBe('문장 3개 선택 (불확실 1, 미연결 1, 위치로 찾음)');
    expect(v.sentences.map((s) => s.notice)).toEqual([UNMAPPED_NOTICE, UNCERTAIN_NOTICE, null]);
  });

  it('빈 결과는 이유 문구만(다른 문장을 대신 보여주지 않는다)', () => {
    expect(selectionView({ sentences: [], reason: 'whitespace_only', byRect: false })).toEqual({
      summary: '공백만 선택했습니다.',
      sentences: [],
    });
    expect(
      selectionView({ sentences: [], reason: 'excluded_block', byRect: true }).summary,
    ).toContain('본문 문장이 아닌');
    expect(selectionView({ sentences: [], reason: 'empty_selection', byRect: false }).summary).toBe(
      '',
    );
  });
});
