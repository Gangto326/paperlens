import { describe, expect, it } from 'vitest';
import type { ConceptCard, TranslationSnapshot } from '@shared/ipc';
import type { ExtractionDocument, Section, Sentence } from '@shared/schema';
import { sampleExtraction } from '@shared/schema/fixtures';
import {
  drawReviewSample,
  formatReviewSheet,
  formatReviewSummary,
  parseReviewSheet,
  quotasOf,
  REVIEW_CHECKLIST,
  summarizeReview,
} from './explanation-review';

const SHA = '7'.repeat(64);

const sentence = (id: string, sectionId: string, order: number): Sentence => ({
  id,
  order,
  page: order % 3,
  pages: [order % 3],
  sectionId,
  paragraphId: `p_${sectionId}`,
  kind: 'sentence',
  enRaw: `English ${id}.`,
  en: `English ${id}.`,
  sourceSpans: [],
  rects: [],
  mappingStatus: 'mapped',
  equations: [],
  citationMarkers: [],
  warnings: [],
});

/** 섹션 셋: 문장 30, 20, 10개. 짝수 번째 문장에 개념 카드가 붙는다. 마지막 섹션의 끝 두 문장은 번역이 없다. */
const build = (): { document: ExtractionDocument; snapshot: TranslationSnapshot } => {
  const sections: Section[] = [];
  const sentences: Sentence[] = [];
  const results: TranslationSnapshot['results'] = {};
  [30, 20, 10].forEach((count, s) => {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const id = `s${String(s)}_${String(i)}`;
      ids.push(id);
      sentences.push(sentence(id, `sec_${String(s)}`, sentences.length));
      if (s === 2 && i >= 8) continue;
      results[id] = {
        ko: `번역 ${id}`,
        note: '',
        explanation: { plain: `쉬운 뜻 ${id}`, role: '역할', example: '', deeper: '- 판정: 예' },
        conceptIds: i % 2 === 0 ? ['c_1', 'c_none'] : [],
        warnings: [],
        chunkId: 'chunk_0001',
      };
    }
    sections.push({
      id: `sec_${String(s)}`,
      title: `섹션 ${String(s)}`,
      order: s,
      sentenceIds: ids,
    });
  });
  const card: ConceptCard = {
    id: 'c_1',
    name: 'BM25',
    nameKo: '비엠25',
    definitionKo: '뜻 첫 줄\n뜻 둘째 줄',
    whyItMatters: '이유',
    exampleKo: null,
    prerequisiteConceptIds: [],
    sourced: true,
    sources: [
      {
        sourceId: 'src_1',
        url: 'https://example.org/bm25',
        title: 'BM25 [교재]',
        publisher: 'example.org',
        kind: 'article',
        language: 'ko',
        supports: '뜻을 설명한다',
      },
    ],
    further: [],
  };
  return {
    document: {
      ...sampleExtraction,
      paper: { ...sampleExtraction.paper, title: '논문 제목' },
      sections,
      sentences,
    },
    snapshot: {
      pdfSha256: SHA,
      state: 'complete',
      generationId: 'gen_1',
      chunks: [],
      results,
      concepts: { c_1: card },
    },
  };
};

describe('quotasOf', () => {
  it('문장 수에 비례해 나누고 합이 크기와 같다', () => {
    expect(quotasOf([30, 20, 8], 30)).toEqual([16, 10, 4]);
    expect(quotasOf([1, 1, 1], 2)).toEqual([1, 1, 0]);
    expect(quotasOf([100, 1], 10)).toEqual([10, 0]);
  });

  it('문장이 크기보다 적으면 모두 뽑는다', () => {
    expect(quotasOf([3, 2], 30)).toEqual([3, 2]);
    expect(quotasOf([], 30)).toEqual([]);
    expect(quotasOf([3, 2], 0)).toEqual([0, 0]);
  });
});

describe('drawReviewSample', () => {
  it('번역이 끝난 문장에서 섹션 비례로 뽑고 읽기 순서로 번호를 붙인다', () => {
    const { document, snapshot } = build();
    const sample = drawReviewSample({ document, snapshot });
    expect(sample).toMatchObject({
      pdfSha256: SHA,
      title: '논문 제목',
      generationId: 'gen_1',
      requested: 30,
      candidates: 58,
    });
    expect(sample.items).toHaveLength(30);
    expect(sample.items.map((i) => i.no)).toEqual(sample.items.map((_, i) => i + 1));
    const bySection = (id: string): number => sample.items.filter((i) => i.sectionId === id).length;
    expect([bySection('sec_0'), bySection('sec_1'), bySection('sec_2')]).toEqual([16, 10, 4]);
    const orders = sample.items.map((i) =>
      document.sentences.findIndex((s) => s.id === i.sentenceId),
    );
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(sample.items.every((i) => snapshot.results[i.sentenceId] !== undefined)).toBe(true);
    expect(sample.items[0]?.page).toBeGreaterThanOrEqual(1);
  });

  it('섹션 몫의 3분의 2를 개념 카드가 붙은 문장에서 뽑는다. 없는 카드 id는 뺀다', () => {
    const { document, snapshot } = build();
    const sample = drawReviewSample({ document, snapshot });
    const inFirst = sample.items.filter((i) => i.sectionId === 'sec_0');
    expect(inFirst.filter((i) => i.concepts.length > 0)).toHaveLength(11);
    expect(inFirst.filter((i) => i.concepts.length === 0)).toHaveLength(5);
    expect(sample.items.flatMap((i) => i.concepts.map((c) => c.id))).not.toContain('c_none');
  });

  it('카드가 붙은 문장이 모자라면 카드 없는 문장으로 채운다', () => {
    const { document, snapshot } = build();
    for (const result of Object.values(snapshot.results)) result.conceptIds = [];
    expect(drawReviewSample({ document, snapshot }).items).toHaveLength(30);
  });

  it('같은 씨앗이면 같은 표본이고 씨앗이 다르면 달라진다', () => {
    const { document, snapshot } = build();
    const ids = (seed?: string): string[] =>
      drawReviewSample({ document, snapshot, ...(seed ? { seed } : {}) }).items.map(
        (i) => i.sentenceId,
      );
    expect(ids()).toEqual(ids());
    expect(ids('다른 씨앗')).not.toEqual(ids());
  });

  it('번역이 없으면 빈 표본이다', () => {
    const { document, snapshot } = build();
    const sample = drawReviewSample({ document, snapshot: { ...snapshot, results: {} } });
    expect(sample).toMatchObject({ candidates: 0, items: [] });
  });
});

describe('formatReviewSheet와 parseReviewSheet', () => {
  it('새 시트는 표본 수만큼 빈 판정을 가진다. 글 안의 판정 줄은 읽지 않는다', () => {
    const { document, snapshot } = build();
    const sheet = formatReviewSheet(drawReviewSample({ document, snapshot, size: 5 }));
    expect(sheet).toContain('> - 판정: 예');
    expect(sheet).toContain('[BM25  교재](<https://example.org/bm25>) (읽은 자료, article, ko)');
    expect(sheet).toContain('> 뜻: 뜻 첫 줄\n> 뜻 둘째 줄');
    // 같은 카드는 처음 나온 표본에만 전문을 싣는다.
    expect(sheet.match(/> 뜻: 뜻 첫 줄/g)).toHaveLength(1);
    expect(sheet).toMatch(/\*\*개념 카드: 비엠25 \(BM25\)\*\* · 내용은 표본 \d+에 있다/);
    const parsed = parseReviewSheet(sheet);
    expect(parsed.problems).toEqual([]);
    expect(parsed.records).toEqual(
      [1, 2, 3, 4, 5].map((no) => ({ no, understood: null, problems: [], memo: '' })),
    );
    expect(summarizeReview(parsed)).toMatchObject({
      total: 5,
      reviewed: 0,
      unreviewed: [1, 2, 3, 4, 5],
      ratio: null,
      passed: false,
    });
  });

  it('적은 판정을 읽고 센다', () => {
    const { document, snapshot } = build();
    const blank = formatReviewSheet(drawReviewSample({ document, snapshot, size: 5 }));
    const answers = [
      ['예', '', ''],
      ['`아니오`', '2, 6', '약어 DPR을 풀지 않음'],
      ['네', '6 6', ''],
      ['O', '', ''],
      ['예', '', ''],
    ];
    let n = 0;
    const filled = blank.replace(/^- 판정:\n- 문제 항목:\n- 메모:$/gm, () => {
      const [verdict, items, memo] = answers[n] ?? [];
      n += 1;
      return `- 판정: ${verdict ?? ''}\n- 문제 항목: ${items ?? ''}\n- 메모: ${memo ?? ''}`;
    });
    expect(n).toBe(5);
    const parsed = parseReviewSheet(filled);
    expect(parsed.problems).toEqual([]);
    expect(parsed.records[1]).toEqual({
      no: 2,
      understood: false,
      problems: [2, 6],
      memo: '약어 DPR을 풀지 않음',
    });
    const summary = summarizeReview(parsed);
    expect(summary).toMatchObject({
      total: 5,
      reviewed: 5,
      understood: 4,
      notUnderstood: 1,
      unreviewed: [],
      ratio: 0.8,
      passed: true,
    });
    expect(summary.problemCounts).toEqual([0, 1, 0, 0, 0, 2, 0]);
    const lines = formatReviewSummary(summary, parsed);
    expect(lines).toContain('표본 2: 아니오, 항목 2, 6, 약어 DPR을 풀지 않음');
    expect(lines.at(-1)).toBe('판정: 통과');
  });

  it('기준에 못 미치거나, 남은 표본이 있거나, 읽지 못한 줄이 있으면 통과가 아니다', () => {
    const sheet = (rows: string[]): string =>
      rows
        .map((row, i) => `### 표본 ${String(i + 1)}\n\n- 판정: ${row}\n- 문제 항목:\n- 메모:\n`)
        .join('\n');
    const verdict = (rows: string[]): boolean =>
      summarizeReview(parseReviewSheet(sheet(rows))).passed;
    expect(verdict(['예', '예', '예', '예', '아니오'])).toBe(true);
    expect(verdict(['예', '예', '예', '아니오', '아니오'])).toBe(false);
    expect(verdict(['예', '예', '예', '예', ''])).toBe(false);
    expect(verdict(['예', '예', '예', '예', '글쎄'])).toBe(false);
    expect(verdict([])).toBe(false);

    const odd = parseReviewSheet(
      `${sheet(['예'])}\n### 표본 1\n\n- 판정: 예\n\n### 표본 2\n\n- 판정: 예\n- 문제 항목: 9, a\n`,
    );
    expect(odd.records.map((r) => r.no)).toEqual([1, 2]);
    expect(odd.problems.map((p) => p.detail)).toEqual([
      '같은 번호의 표본이 두 번 나온다',
      '문제 항목 번호가 아니다: "9"',
      '문제 항목 번호가 아니다: "a"',
    ]);
  });

  it('체크리스트는 PLAN 12.3의 일곱 항목이다', () => {
    expect(REVIEW_CHECKLIST).toHaveLength(7);
  });
});
