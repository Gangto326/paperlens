import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../cache/hash';
import { classifySentenceText, normalizeTei, TEI_NORMALIZER_VERSION } from './tei-normalize';

// 실제 GROBID 0.9.1-crf 출력(2005.11401)에서 구조를 그대로 잘라낸 소형 TEI.
// 초록 2문장, Introduction 3문장, RAG-Sequence Model 2문장+formula, Models(head만 있는 div),
// RAG-Token Model 1문장, figure(fig_0)+figDesc, table(tab_0)+figDesc, footnote 1, Acknowledgments 1문장,
// biblStruct 2개(b46은 Introduction 첫 문장이 인용, b4는 미인용). 둘 다 DOI 보유.
const MINI = readFileSync(resolve(__dirname, '__fixtures__/grobid-0.9.1-mini.tei.xml'), 'utf8');
const SHA = 'f'.repeat(64);
const REV = 'r062054656382';
const run = () => normalizeTei(MINI, { pdfSha256: SHA, extractionRevision: REV });

describe('normalizeTei (mini fixture)', () => {
  it('섹션·문장·제외 블록·참고문헌 개수가 수동 집계와 같다', () => {
    const r = run();
    expect(r.sections.map((s) => [s.title, s.sentenceIds.length])).toEqual([
      ['Abstract', 2],
      ['Introduction', 3],
      ['RAG-Sequence Model', 2],
      ['Models', 0],
      ['RAG-Token Model', 1],
      ['Acknowledgments', 1],
    ]);
    expect(r.sentences).toHaveLength(9);
    expect(r.excludedBlocks.map((x) => x.type)).toEqual([
      'formula',
      'figure',
      'caption',
      'table',
      'caption',
      'footnote',
      'bibliography',
      'bibliography',
    ]);
    expect(r.bibliography).toHaveLength(2);
    // 실제 TEI에서 잘라낸 fixture라 Introduction 2·3번째 문장의 인용 대상(b50·b51·b37)은
    // listBibl에 없다. 이 경고가 문서 수준으로 올라오는지를 함께 확인한다.
    expect(r.warnings).toEqual([
      'citation_target_missing:b50',
      'citation_target_missing:b51',
      'citation_target_missing:b37',
    ]);
  });

  it('메타데이터를 teiHeader에서 읽는다', () => {
    const r = run();
    expect(r.metadata).toEqual({
      title: 'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks',
      authors: ['Patrick Lewis', 'Ethan Perez'],
      year: 2021,
      doi: null,
    });
  });

  it('문장 ID는 sha256(pdfSha256:rev:order) 단축형이고 order는 읽기 순서', () => {
    const r = run();
    r.sentences.forEach((s, i) => {
      expect(s.order).toBe(i);
      expect(s.id).toBe(`s_${sha256Hex(`${SHA}:${REV}:${i}`).slice(0, 16)}`);
    });
    // 같은 입력이면 같은 ID, rev가 다르면 다른 ID
    const again = run();
    expect(again.sentences.map((s) => s.id)).toEqual(r.sentences.map((s) => s.id));
    const other = normalizeTei(MINI, { pdfSha256: SHA, extractionRevision: 'rother' });
    expect(other.sentences[0]?.id).not.toBe(r.sentences[0]?.id);
  });

  it('문장 텍스트는 ref 포함 원문 그대로, 인용 표식과 참고문헌 역참조를 기록한다', () => {
    const r = run();
    const first = r.sentences[2]!; // Introduction 첫 문장
    expect(first.enRaw).toBe(
      'Pre-trained neural language models have been shown to learn a substantial amount of in-depth knowledge from data [47].',
    );
    expect(first.en).toBe(first.enRaw);
    expect(first.citationMarkers).toEqual(['[47]']);
    expect(first.kind).toBe('sentence');
    expect(first.warnings).toEqual([]);
    expect(first.page).toBe(0);
    expect(first.pages).toEqual([0]);
    expect(first.rects).toHaveLength(2);
    expect(first.rects[0]).toMatchObject({
      pageIndex: 0,
      x: 108,
      y: 624.04,
      width: 397.65,
      height: 8.64,
      coordinateSpace: 'grobid_top_left_pdf_units',
    });
    expect(first.mappingStatus).toBe('unmapped');
    expect(first.sourceSpans).toEqual([]);

    const b46 = r.bibliography.find((b) => b.title === 'Language models as knowledge bases?')!;
    expect(b46.citingSentenceIds).toEqual([first.id]);
    expect(b46.year).toBe(2019);
    expect(b46.urlFromPdf).toBe('https://www.aclweb.org/anthology/D19-1250');
    expect(b46.authors.length).toBe(7);
    expect(b46.doi).toBe('10.18653/v1/D19-1250');
    const b4 = r.bibliography.find(
      (b) => b.title === 'Reading Wikipedia to Answer Open-Domain Questions',
    )!;
    expect(b4.doi).toBe('10.18653/v1/P17-1171');
    expect(b4.year).toBe(2017);
    expect(b4.citingSentenceIds).toEqual([]);
  });

  it('쉼표로 끝나는 문장(수식 앞)은 fragment로 표시한다', () => {
    const r = run();
    const beforeFormula = r.sentences.find((s) => s.enRaw.endsWith('marginalized,'))!;
    expect(beforeFormula.kind).toBe('fragment');
    expect(beforeFormula.warnings).toEqual(['boundary_no_terminal_punctuation']);
    expect(beforeFormula.sectionId).toBe(r.sections[2]!.id);
  });

  it('제외 블록은 좌표·원문·사유를 보존한다', () => {
    const r = run();
    const formula = r.excludedBlocks[0]!;
    expect(formula.rects).toHaveLength(1);
    expect(formula.pageIndices).toEqual([2]);
    expect(formula.rawText).toContain('RAG-Sequence');
    expect(formula.reason).toBe('GROBID <formula>');
    const table = r.excludedBlocks.find((x) => x.type === 'table')!;
    expect(table.rawText).toContain('Table 1');
    expect(table.reason).toContain('tab_0');
    const caption = r.excludedBlocks[2]!;
    expect(caption.type).toBe('caption');
    expect(caption.rawText).toContain('Figure 2');
    expect(caption.rects.length).toBeGreaterThan(0);
    const foot = r.excludedBlocks.find((x) => x.type === 'footnote')!;
    expect(foot.reason).toBe('GROBID <note place="foot" n="1">');
    expect(foot.pageIndices).toEqual([1]);
    const bib = r.excludedBlocks.filter((x) => x.type === 'bibliography');
    expect(bib.every((x) => x.rects.length > 0)).toBe(true);
    // 제외 블록 ID는 서로 다르고 결정적
    expect(new Set(r.excludedBlocks.map((x) => x.id)).size).toBe(r.excludedBlocks.length);
    expect(run().excludedBlocks.map((x) => x.id)).toEqual(r.excludedBlocks.map((x) => x.id));
  });

  it('섹션 parentId는 head n의 상위 번호가 있을 때만 잇는다', () => {
    const r = run();
    // "2.1 Models"의 상위 "2"는 이 fixture에 없으므로 null
    expect(r.sections.map((s) => s.parentId)).toEqual([null, null, null, null, null, null]);
  });

  it('TEI 루트가 없으면 던진다', () => {
    expect(() => normalizeTei('<x/>', { pdfSha256: SHA, extractionRevision: REV })).toThrow();
    expect(TEI_NORMALIZER_VERSION).toBe('1');
  });
});

describe('classifySentenceText — Fig.·et al. 경계 검사', () => {
  it.each([
    ['A normal sentence.', 'sentence', []],
    ['Ends with question?', 'sentence', []],
    ['Quoted end."', 'sentence', []],
    ['we define:', 'fragment', ['boundary_no_terminal_punctuation', 'boundary_lowercase_start']],
    ['As shown in Fig.', 'sentence', ['boundary_abbreviation_end']],
    ['Smith et al.', 'sentence', ['boundary_abbreviation_end']],
    ['specific tasks, e.g.', 'sentence', ['boundary_abbreviation_end', 'boundary_lowercase_start']],
    ['See Eq.', 'sentence', ['boundary_abbreviation_end']],
    [
      'https://github.com/pytorch/fairseq',
      'fragment',
      ['boundary_no_terminal_punctuation', 'boundary_lowercase_start'],
    ],
    ['', 'fragment', ['empty_text']],
  ])('%j → %s %j', (text, kind, warnings) => {
    expect(classifySentenceText(text)).toEqual({ kind, warnings });
  });
});
