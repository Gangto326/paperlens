import { describe, expect, it } from 'vitest';
import type { ChunkDocument, ContextDocument, ExtractionDocument, Sentence } from '@shared/schema';
import { sampleChunk, sampleContext, sampleExtraction } from '@shared/schema/fixtures';
import { sha256Hex, stableStringify } from '../cache/hash';
import {
  evaluateTranslation,
  formatEvaluation,
  keepsOriginal,
  preferredForms,
} from './translation-eval';

const sentence = (n: number, en: string): Sentence => ({
  id: `id_${n}`,
  order: n,
  page: 0,
  pages: [0],
  sectionId: 'sec_a',
  paragraphId: 'p_1',
  kind: 'sentence',
  enRaw: en,
  en,
  sourceSpans: [],
  rects: [],
  mappingStatus: 'mapped',
  equations: [],
  citationMarkers: [],
  warnings: [],
});
const SENTENCES = [
  sentence(0, 'We propose retrieval-augmented generation.'),
  sentence(1, 'RAG uses a retriever.'),
  sentence(2, 'The retriever is dense.'),
  sentence(3, 'Beam search is used for decoding.'),
];
const document: ExtractionDocument = {
  ...sampleExtraction,
  sections: [{ id: 'sec_a', title: 'A', order: 0, sentenceIds: SENTENCES.map((s) => s.id) }],
  sentences: SENTENCES,
};
const entry = (
  id: string,
  term: string,
  aliases: string[],
  preferredKo: string,
): ContextDocument['glossary'][number] => ({
  id,
  term,
  aliases,
  preferredKo,
  displayRule: '',
  meaningInPaper: '',
  evidenceSentenceIds: [],
  conceptIds: [],
});
const context: ContextDocument = {
  ...sampleContext,
  glossary: [
    entry('g_1', 'retrieval-augmented generation', ['RAG'], '검색 증강 생성(RAG)'),
    entry('g_2', 'retriever', [], '검색기'),
    entry('g_3', 'beam search', [], '빔 탐색'),
    entry('g_4', 'FAISS', [], 'FAISS'),
  ],
};
const chunk = (
  id: string,
  rows: [string, string][],
  over: Partial<ChunkDocument> = {},
): ChunkDocument => {
  const results = rows.map(([sid, ko]) => ({
    id: sid,
    ko,
    note: '',
    refs: [],
    conceptIds: [],
    warnings: [],
  }));
  return {
    ...sampleChunk,
    id,
    sectionId: 'sec_a',
    targetSentenceIds: rows.map(([sid]) => sid),
    status: 'complete',
    results,
    resultHash: sha256Hex(stableStringify(results)),
    ...over,
  };
};
const GOOD = [
  chunk('chunk_0001', [
    ['id_0', '우리는 검색 증강 생성을 제안한다.'],
    ['id_1', 'RAG는 검색기를 사용한다.'],
  ]),
  chunk('chunk_0002', [
    ['id_2', '검색기는 밀집 방식이다.'],
    ['id_3', '디코딩에는 빔 탐색을 사용한다.'],
  ]),
];

describe('evaluateTranslation', () => {
  it('정상 세대는 ID 불일치와 용어 위반이 없다', () => {
    const e = evaluateTranslation({ document, context, chunks: GOOD });
    expect(e).toMatchObject({
      sentences: 4,
      translated: 4,
      chunks: 2,
      completeChunks: 2,
      idProblems: [],
      termViolations: [],
      termOccurrences: 4,
      aliasOnlyOccurrences: 1,
    });
    expect(
      e.terms.map((t) => [t.glossaryId, t.occurrences, t.withPreferred, t.withOriginalOnly]),
    ).toEqual([
      ['g_1', 1, 1, 0],
      ['g_2', 2, 2, 0],
      ['g_3', 1, 1, 0],
      ['g_4', 0, 0, 0],
    ]);
  });

  it('선호 표기도 원어도 없는 번역은 용어 위반이다', () => {
    const chunks = [
      GOOD[0] as ChunkDocument,
      chunk('chunk_0002', [
        ['id_2', '탐색 장치는 밀집 방식이다.'],
        ['id_3', '디코딩에는 beam search를 사용한다.'],
      ]),
    ];
    const e = evaluateTranslation({ document, context, chunks });
    expect(e.termViolations.map((v) => [v.glossaryId, v.sentenceId, v.chunkId])).toEqual([
      ['g_2', 'id_2', 'chunk_0002'],
    ]);
    expect(e.terms.find((t) => t.glossaryId === 'g_3')).toMatchObject({
      withPreferred: 0,
      withOriginalOnly: 1,
      violations: 0,
    });
  });

  it('ID 불일치를 종류별로 잡는다', () => {
    const codes = (chunks: ChunkDocument[]): string[] =>
      evaluateTranslation({ document, context, chunks }).idProblems.map((p) => p.code);
    const [a, b] = GOOD as [ChunkDocument, ChunkDocument];
    expect(codes([a])).toEqual(['sentence_without_result', 'sentence_without_result']);
    expect(codes([a, { ...b, status: 'failed' }])).toEqual([
      'chunk_not_complete',
      'sentence_without_result',
      'sentence_without_result',
    ]);
    expect(codes([a, b, chunk('chunk_0003', [['id_3', '다시']])])).toEqual([
      'sentence_in_two_chunks',
    ]);
    expect(codes([a, chunk('chunk_0002', [...rowsOf(b), ['id_99', '없는 문장']])])).toEqual([
      'unknown_sentence',
    ]);
    expect(codes([a, { ...b, targetSentenceIds: ['id_3', 'id_2'] }])).toEqual([
      'result_ids_differ_from_targets',
    ]);
    expect(codes([a, { ...b, resultHash: 'x' }])).toEqual(['result_hash_mismatch']);
    expect(
      codes([
        a,
        chunk('chunk_0002', [
          ['id_2', ' '],
          ['id_3', '디코딩에는 빔 탐색을 사용한다.'],
        ]),
      ]),
    ).toEqual(['empty_translation']);
  });

  it('보고 글에 개수와 위반 문장이 들어간다', () => {
    const e = evaluateTranslation({
      document,
      context,
      chunks: [GOOD[0] as ChunkDocument, chunk('chunk_0002', [['id_2', '탐색 장치다.']])],
    });
    const text = formatEvaluation(e).join('\n');
    expect(text).toContain('ID 불일치 1건');
    expect(text).toContain('위반 1건, 별칭만 나와 검사하지 않음 1회');
    expect(text).toContain('KO 탐색 장치다.');
  });
});

const rowsOf = (c: ChunkDocument): [string, string][] => c.results.map((r) => [r.id, r.ko]);

describe('preferredForms', () => {
  it('괄호 설명이 붙은 표기는 괄호 앞부분도 같은 표기로 본다', () => {
    expect(preferredForms({ preferredKo: '검색 증강 생성(RAG)' })).toEqual([
      '검색 증강 생성(RAG)',
      '검색 증강 생성',
    ]);
    expect(preferredForms({ preferredKo: '검색기' })).toEqual(['검색기']);
    expect(preferredForms({ preferredKo: ' ' })).toEqual([]);
  });

  it('허용 표기도 지킨 표기로 본다', () => {
    expect(
      preferredForms({ preferredKo: '문서 조각', acceptedKo: ['문서', ' 패시지(passage) ', ''] }),
    ).toEqual(['문서 조각', '문서', '패시지(passage)', '패시지']);
  });
});

describe('keepsOriginal', () => {
  it('조사가 붙은 원어를 찾고 다른 영어 낱말의 일부는 세지 않는다', () => {
    expect(keepsOriginal('RAG는 검색기를 쓴다.', 'RAG')).toBe(true);
    expect(keepsOriginal('seq2seq(시퀀스 간 변환) 모델', 'seq2seq')).toBe(true);
    expect(keepsOriginal('fragment를 쓴다.', 'RAG')).toBe(false);
    expect(keepsOriginal('RAGs는 다르다.', 'RAG')).toBe(false);
    expect(keepsOriginal('아무 글', ' ')).toBe(false);
  });
});
