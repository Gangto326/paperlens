import { describe, expect, it } from 'vitest';
import type { SentenceIndexEntry } from '@shared/mapping/selection';
import type { TranslationSnapshot } from '@shared/ipc';
import {
  FAILED_TRANSLATION,
  PENDING_TRANSLATION,
  lookupOf,
  warningText,
  UNCERTAIN_NOTICE,
  UNMAPPED_NOTICE,
  selectionView,
  splitEquations,
  translationView,
  UNSOURCED_BADGE,
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
      translation: { state: 'pending', text: PENDING_TRANSLATION },
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

describe('번역 표시', () => {
  const snapshot: TranslationSnapshot = {
    pdfSha256: 'a'.repeat(64),
    state: 'translating',
    generationId: 'gen_1',
    chunks: [
      { id: 'chunk_0001', status: 'complete', sentenceIds: ['s1', 's2'] },
      { id: 'chunk_0002', status: 'failed', sentenceIds: ['s3'] },
      { id: 'chunk_0003', status: 'pending', sentenceIds: ['s4'] },
    ],
    results: {
      s1: { ko: '안녕 세계.', note: '', warnings: [], chunkId: 'chunk_0001' },
      s2: {
        ko: '정확도는 높다.',
        note: '정확도는 맞힌 비율이다.',
        warnings: ['number_missing: 44.5', '원문이 잘려 있다'],
        chunkId: 'chunk_0001',
      },
    },
  };
  const select = (ids: string[]): ReturnType<typeof selectionView> =>
    selectionView(
      {
        sentences: ids.map((id, i) => entry(id, i, `en ${id}`)),
        reason: 'ok',
        byRect: false,
      },
      lookupOf(snapshot),
    );

  it('완료 문장은 번역을 보여주고 빈 해설은 숨긴다', () => {
    const v = select(['s1', 's2']);
    expect(v.sentences[0]?.translation).toEqual({
      state: 'complete',
      ko: '안녕 세계.',
      note: null,
      sections: [],
      concepts: [],
      warnings: [],
    });
    expect(v.sentences[1]?.translation).toEqual({
      state: 'complete',
      ko: '정확도는 높다.',
      note: '정확도는 맞힌 비율이다.',
      sections: [],
      concepts: [],
      warnings: ['원문의 수치 44.5가 번역에 그대로 보이지 않습니다', '원문이 잘려 있다'],
    });
  });

  it('해설은 글이 있는 칸만 보이고, 쉬운 뜻과 역할만 처음부터 펼친다', () => {
    const v = translationView({
      ko: '번역',
      note: '',
      explanation: { plain: '쉬운 뜻 글', role: ' ', example: '사례 글', deeper: '깊은 글' },
      warnings: [],
      chunkId: 'chunk_0001',
    });
    if (v.state !== 'complete') throw new Error('state');
    expect(v.sections.map((s) => [s.key, s.label, s.open, s.text])).toEqual([
      ['plain', '쉬운 뜻', true, '쉬운 뜻 글'],
      ['example', '구체적 사례', false, '사례 글'],
      ['deeper', '더 깊은 설명', false, '깊은 글'],
    ]);
  });

  it('칸 셋 세대는 해설과 주의할 점을 펼쳐 보이고 예시는 접는다. 글을 단락·목록으로 나눠 넘긴다', () => {
    const v = translationView({
      ko: '번역',
      note: '',
      explanation: {
        main: '문서를 **토큰마다** 섞는다.\n\n- 잠재 문서\n- 주변화',
        caution: '검색은 한 번이다.',
        plain: '',
        role: '',
        example: '0.6×0.9 = 0.54',
        deeper: '',
      },
      warnings: [],
      chunkId: 'chunk_0001',
    });
    if (v.state !== 'complete') throw new Error('state');
    expect(v.sections.map((s) => [s.key, s.label, s.open])).toEqual([
      ['main', '해설', true],
      ['example', '예시', false],
      ['caution', '주의할 점', true],
    ]);
    expect(v.sections[0]?.blocks).toEqual([
      {
        kind: 'paragraph',
        lines: [
          [
            { text: '문서를 ', bold: false },
            { text: '토큰마다', bold: true },
            { text: ' 섞는다.', bold: false },
          ],
        ],
      },
      {
        kind: 'list',
        ordered: false,
        items: [[{ text: '잠재 문서', bold: false }], [{ text: '주변화', bold: false }]],
      },
    ]);
  });

  it('개념 카드는 통용 표기와 원어를 함께 보이고, 출처 없는 설명을 표시한다', () => {
    const card = {
      id: 'c_1',
      name: 'fine-tuning',
      nameKo: '파인튜닝',
      definitionKo: '학습된 모델을 더 학습시키는 것.',
      whyItMatters: '',
      exampleKo: null,
      prerequisiteConceptIds: ['c_2', 'c_404'],
      sourced: false,
      sources: [],
      further: [
        {
          sourceId: 'src_2',
          url: 'https://video.example/b',
          title: ' ',
          publisher: 'video.example',
          kind: 'video',
          language: 'KO',
          supports: '',
        },
      ],
    };
    const concepts = {
      c_1: card,
      c_2: {
        ...card,
        id: 'c_2',
        name: 'pre-training',
        nameKo: null,
        prerequisiteConceptIds: [],
        sourced: true,
        sources: [
          {
            sourceId: 'src_1',
            url: 'https://read.example/a',
            title: 'BM25 교재',
            publisher: null,
            kind: 'book',
            language: null,
            supports: '뜻을 설명한다',
          },
        ],
        further: [],
      },
    };
    const v = translationView(
      { ko: '번역', note: '', conceptIds: ['c_1', 'c_404', 'c_2'], warnings: [], chunkId: 'x' },
      concepts,
    );
    if (v.state !== 'complete') throw new Error('state');
    expect(v.concepts).toEqual([
      {
        id: 'c_1',
        title: '파인튜닝(fine-tuning)',
        badge: UNSOURCED_BADGE,
        rows: [
          { label: '뜻', text: '학습된 모델을 더 학습시키는 것.' },
          { label: '먼저 알 것', text: 'pre-training' },
        ].map((row) => expect.objectContaining(row) as unknown),
        sources: [],
        further: [
          {
            url: 'https://video.example/b',
            title: 'https://video.example/b',
            meta: '영상 · 한국어 · video.example',
            supports: null,
          },
        ],
      },
      {
        id: 'c_2',
        title: 'pre-training',
        badge: null,
        rows: [
          expect.objectContaining({
            label: '뜻',
            text: '학습된 모델을 더 학습시키는 것.',
          }) as unknown,
        ],
        sources: [
          {
            url: 'https://read.example/a',
            title: 'BM25 교재',
            meta: 'book',
            supports: '뜻을 설명한다',
          },
        ],
        further: [],
      },
    ]);
  });

  it('미완료 문장은 처리 대기, 실패한 청크의 문장은 실패로 표시한다', () => {
    const v = select(['s4', 's3', 'unknown']);
    expect(v.sentences.map((s) => s.translation)).toEqual([
      { state: 'pending', text: PENDING_TRANSLATION },
      { state: 'failed', text: FAILED_TRANSLATION },
      { state: 'pending', text: PENDING_TRANSLATION },
    ]);
  });

  it('스냅샷이 없으면 모두 처리 대기다', () => {
    expect(lookupOf(null)('s1')).toEqual({ state: 'pending', text: PENDING_TRANSLATION });
  });

  it('모르는 경고는 그대로 둔다', () => {
    expect(warningText('원문이 잘려 있다')).toBe('원문이 잘려 있다');
  });
});
