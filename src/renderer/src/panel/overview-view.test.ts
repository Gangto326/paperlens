import { describe, expect, it } from 'vitest';
import type { TranslationSnapshot } from '@shared/ipc';
import { overviewView } from './overview-view';

const base: TranslationSnapshot = {
  pdfSha256: 'a'.repeat(64),
  state: 'context_pending',
  generationId: 'gen_1',
  chunks: [],
  results: {},
  concepts: {
    c_1: {
      id: 'c_1',
      name: 'retrieval',
      nameKo: '검색',
      definitionKo: '문서를 **찾아오는** 일',
      whyItMatters: '첫 단계',
      exampleKo: null,
      prerequisiteConceptIds: [],
      sourced: false,
      sources: [],
      further: [],
    },
  },
  overview: {
    summary: '한 문단 요약.',
    researchQuestion: '무엇을 푸는가.',
    contributions: ['기여 1', '기여 2'],
    methodOverview: '',
    mainResults: [],
    limitations: ['한계 1'],
    unresolved: [],
    glossary: [
      {
        term: 'fine-tuning',
        aliases: ['FT'],
        preferredKo: '파인튜닝',
        acceptedKo: ['미세 조정'],
        meaningInPaper: '이미 학습한 모델을 더 학습',
      },
      { term: 'retriever', aliases: [], preferredKo: '검색기', acceptedKo: [], meaningInPaper: '' },
    ],
  },
};

describe('overviewView', () => {
  it('글이 있는 항목만 순서대로 넣고 용어집과 개념 카드를 옮긴다', () => {
    const view = overviewView(base);
    expect(view?.items.map((i) => i.label)).toEqual(['요약', '풀려는 문제', '기여', '한계']);
    expect(view?.items[2]?.blocks).toEqual([
      {
        kind: 'list',
        ordered: false,
        items: [[{ text: '기여 1', bold: false }], [{ text: '기여 2', bold: false }]],
      },
    ]);
    expect(view?.glossary).toEqual([
      {
        term: 'fine-tuning (FT)',
        ko: '파인튜닝 · 미세 조정',
        meaning: '이미 학습한 모델을 더 학습',
      },
      { term: 'retriever', ko: '검색기', meaning: '' },
    ]);
    expect(view?.concepts.map((c) => c.title)).toEqual(['검색(retrieval)']);
  });

  it('컨텍스트가 없으면 null', () => {
    expect(overviewView(null)).toBeNull();
    expect(overviewView({ ...base, overview: null })).toBeNull();
    const { overview: _dropped, ...without } = base;
    expect(overviewView(without)).toBeNull();
  });
});
