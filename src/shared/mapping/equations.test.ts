import { describe, expect, it } from 'vitest';
import type { SourceSpan, TextItemRecord } from '../schema/types';
import {
  EQUATION_DETECTOR_VERSION,
  InlineEquationDetector,
  equationStats,
  type EquationDetection,
} from './equations';

/** 글꼴 내부 이름 → 실제 이름(서브셋 접두 포함). */
const FONTS = new Map<string, string>([
  ['T', 'ABCDEF+NimbusRomNo9L-Regu'],
  ['TI', 'ABCDEF+NimbusRomNo9L-ReguItal'],
  ['MI10', 'ABCDEF+CMMI10'],
  ['MI7', 'ABCDEF+CMMI7'],
  ['SY10', 'ABCDEF+CMSY10'],
  ['SY7', 'ABCDEF+CMSY7'],
  ['R10', 'ABCDEF+CMR10'],
  ['R7', 'ABCDEF+CMR7'],
  ['SFTI', 'ABCDEF+SFTI1000'],
  ['SFRM', 'ABCDEF+SFRM1000'],
]);

interface Spec {
  str: string;
  font?: string;
  h?: number;
  y?: number;
  eol?: boolean;
  page?: number;
}

let x = 100;
/** 가로 글 항목을 왼쪽부터 차례로 놓는다(폭 = 글자 수 × 5pt). */
function items(specs: Spec[]): TextItemRecord[] {
  x = 100;
  return specs.map((s, index) => {
    const h = s.h ?? 10;
    const width = s.str.length * 5;
    const it: TextItemRecord = {
      id: `t_${s.page ?? 0}_${index}`,
      pageIndex: s.page ?? 0,
      index,
      str: s.str,
      transform: [h, 0, 0, h, x, s.y ?? 100],
      width,
      height: s.str.trim() === '' ? 0 : h,
      fontName: s.font ?? 'T',
      dir: 'ltr',
      hasEOL: s.eol ?? false,
    };
    x += width;
    return it;
  });
}

const span = (it: TextItemRecord, start = 0, end = it.str.length): SourceSpan => ({
  pageIndex: it.pageIndex,
  textItemId: it.id,
  utf16Start: start,
  utf16End: end,
  normalizedStart: start,
  normalizedEnd: end,
  normalizationMapId: `nm_${it.id}`,
});

function detect(
  specs: Spec[],
  en: string,
  fonts: Map<string, string> | null = FONTS,
): EquationDetection {
  const its = items(specs);
  const detector = new InlineEquationDetector(
    its,
    fonts ? { fontNameOf: (f) => fonts.get(f) } : {},
  );
  return detector.detect({ id: 's_1', en, sourceSpans: its.map((it) => span(it)) });
}

const sp = (h = 10): Spec => ({ str: ' ', h });
const sub = (str: string, font = 'MI7'): Spec => ({ str, font, h: 7, y: 98.5 });

describe('InlineEquationDetector', () => {
  it('TeX 수식(수학 글꼴·첨자·기호)은 detected이고 [EQ_1]로 치환된다', () => {
    const r = detect(
      [
        { str: 'the retriever' },
        sp(),
        { str: 'p', font: 'MI10' },
        sub('η'),
        sp(7),
        { str: '(', font: 'R10' },
        { str: 'z', font: 'MI10' },
        { str: '|', font: 'SY10' },
        { str: 'x', font: 'MI10' },
        { str: ')', font: 'R10' },
        sp(),
        { str: 'with parameters' },
      ],
      'the retriever p η (z|x) with parameters',
    );
    expect(r.equations).toHaveLength(1);
    const e = r.equations[0]!;
    expect(e.token).toBe('[EQ_1]');
    expect(e.id).toBe('s_1_eq1');
    expect(e.detectionStatus).toBe('detected');
    expect(e.warning).toBeNull();
    expect(e.rawText).toBe('pη (z|x)');
    expect(r.en).toBe('the retriever [EQ_1] with parameters');
    expect(e.sourceSpans.map((s) => s.textItemId)).toEqual([
      't_0_2',
      't_0_3',
      't_0_4',
      't_0_5',
      't_0_6',
      't_0_7',
      't_0_8',
      't_0_9',
    ]);
    expect(r.signals[0]).toEqual({ font: 5, symbol: 2, script: 1, weak: 0 });
    // 한 줄이므로 사각형 하나: p의 왼쪽부터 )의 오른쪽까지, user space
    expect(e.rects).toHaveLength(1);
    const rect = e.rects[0]!;
    expect(rect.coordinateSpace).toBe('pdf_user_space');
    expect(rect.x).toBeCloseTo(100 + 13 * 5 + 5, 6);
    expect(rect.width).toBeCloseTo(8 * 5, 6);
    expect(rect.y).toBeCloseTo(98.5, 6);
    expect(rect.height).toBeCloseTo(11.5, 6);
    expect(r.skipped).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('단일 변수·텍스트 첨자·각주 숫자·기호 하나·글자 없는 후보는 자리표시자를 만들지 않는다', () => {
    const r = detect(
      [
        { str: 'given a query' },
        sp(),
        { str: 'x', font: 'MI10' },
        sp(),
        { str: 'and a BERT' },
        { str: 'BASE', h: 7, y: 98.5 },
        sp(),
        { str: 'encoder' },
        { str: '1', h: 7, y: 103 },
        sp(),
        { str: 'stores' },
        sp(),
        { str: '∼', font: 'SY10' },
        sp(),
        { str: '100GB [VSP' },
        { str: '+', h: 7, y: 103 },
        { str: '17,' },
        sp(),
        { str: 'LHM' },
        { str: '+', h: 7, y: 103 },
        { str: '23].' },
      ],
      'given a query x and a BERT BASE encoder 1 stores ∼ 100GB [VSP + 17, LHM + 23].',
    );
    expect(r.equations).toEqual([]);
    expect(r.en).toBe(
      'given a query x and a BERT BASE encoder 1 stores ∼ 100GB [VSP + 17, LHM + 23].',
    );
    expect(r.skipped).toEqual([
      { kind: 'single_variable', rawText: 'x' },
      { kind: 'text_script', rawText: 'BASE' },
      { kind: 'text_script', rawText: '1' },
      { kind: 'single_symbol', rawText: '∼' },
      { kind: 'no_letter', rawText: '+17,' },
      { kind: 'single_symbol', rawText: '+' },
    ]);
  });

  it('글꼴 표가 없어도 첨자+기호로 검출하고, 대시 종류가 달라도 문장에서 위치를 찾는다', () => {
    const specs: Spec[] = [
      { str: 'previous' },
      sp(),
      { str: 'y' },
      sub('1:', 'R7'),
      sub('i'),
      sub('−', 'SY7'),
      sub('1', 'R7'),
      { str: ', the' },
    ];
    const r = detect(specs, 'previous y 1:i-1 , the', null);
    expect(r.equations).toHaveLength(1);
    expect(r.equations[0]!.detectionStatus).toBe('detected');
    expect(r.equations[0]!.rawText).toBe('y1:i−1');
    expect(r.signals[0]).toEqual({ font: 0, symbol: 1, script: 4, weak: 1 });
    expect(r.en).toBe('previous [EQ_1] , the');

    const miss = detect(specs, 'previous tokens, the', null);
    expect(miss.equations[0]).toMatchObject({
      token: '[EQ_1]',
      detectionStatus: 'math_uncertain',
      warning: 'not_in_sentence_text',
    });
    expect(miss.en).toBe('previous tokens, the');
  });

  it('이탤릭 본문 글꼴의 짧은 항목은 약한 신호: 둘 이상이면 math_uncertain, 하나뿐이면 조용히 무시한다', () => {
    const r = detect(
      [
        { str: 'let', font: 'SFRM' },
        sp(),
        { str: 'f', font: 'SFTI' },
        { str: '(', font: 'SFRM' },
        { str: 'x', font: 'SFTI' },
        { str: ')', font: 'SFRM' },
        sp(),
        { str: 'and', font: 'SFRM' },
        sp(),
        { str: 'x', font: 'SFTI' },
        { str: '.', font: 'SFRM' },
      ],
      'let f (x) and x.',
    );
    expect(r.equations).toHaveLength(1);
    expect(r.equations[0]).toMatchObject({ rawText: 'f(x)', detectionStatus: 'math_uncertain' });
    expect(r.signals[0]).toEqual({ font: 0, symbol: 0, script: 0, weak: 2 });
    expect(r.en).toBe('let [EQ_1] and x.');
    // 약한 신호 하나뿐인 항목(관사 a·이탤릭 x)은 후보로 세지 않아 skipped에도 남지 않는다
    expect(r.skipped).toEqual([]);
  });

  it('글자별로 쪼개진 문장에서는 glyph 신호를 끄고 경고만 남긴다', () => {
    const r = detect(
      ['W', 'e', ' ', 'g', 'o', ' ', 'n', 'o', 'w', '.'].map((str) => ({ str })),
      'We go now.',
    );
    expect(r.equations).toEqual([]);
    expect(r.warnings).toEqual(['glyph_fragmented_sentence']);
  });

  it('여러 수식은 순서대로 번호를 받고, 끝의 구두점은 떼며 짝이 맞는 닫는 괄호·기호 뒤 숫자는 남긴다', () => {
    const r = detect(
      [
        { str: 'p', font: 'MI10' },
        { str: '(', font: 'R10' },
        { str: 'y', font: 'MI10' },
        { str: ')', font: 'R10' },
        sp(),
        { str: 'and' },
        sp(),
        { str: 'k', font: 'MI10' },
        sp(),
        { str: '∈', font: 'SY10' },
        sp(),
        { str: '{5,', font: 'R10' },
        sp(),
        { str: '10}', font: 'R10' },
        sp(),
        { str: 'and' },
        sp(),
        { str: 'z', font: 'MI10' },
        sub('i'),
        sp(),
        { str: '≈', font: 'SY10' },
        sp(),
        { str: '0', font: 'R10' },
        { str: '.', font: 'R10' },
      ],
      'p(y) and k ∈ {5, 10} and z i ≈ 0.',
    );
    expect(r.equations.map((e) => [e.token, e.rawText, e.detectionStatus])).toEqual([
      ['[EQ_1]', 'p(y)', 'detected'],
      ['[EQ_2]', 'k ∈ {5, 10}', 'detected'],
      ['[EQ_3]', 'zi ≈ 0', 'detected'],
    ]);
    expect(r.en).toBe('[EQ_1] and [EQ_2] and [EQ_3].');
  });

  it('로만체 함수 이름(log)은 수식 사이에 흡수된다', () => {
    const r = detect(
      [
        { str: 'minimize' },
        sp(),
        { str: 'j', font: 'MI10' },
        sp(),
        { str: '−', font: 'SY10' },
        { str: 'log', font: 'R10' },
        sp(),
        { str: 'p', font: 'MI10' },
        { str: '(', font: 'R10' },
        { str: 'y', font: 'MI10' },
        { str: ')', font: 'R10' },
        sp(),
        { str: 'using' },
      ],
      'minimize j -log p(y) using',
    );
    expect(r.equations.map((e) => e.rawText)).toEqual(['j −log p(y)']);
    expect(r.en).toBe('minimize [EQ_1] using');
  });

  it('줄바꿈을 넘는 수식은 줄마다 사각형을 갖고, 부분 스팬은 가로로 비례 절단된다', () => {
    const its = items([
      { str: 'abc p', font: 'MI10', eol: true },
      { str: '(', font: 'R10', y: 88 },
      { str: 'y', font: 'MI10', y: 88 },
      { str: ')', font: 'R10', y: 88 },
    ]);
    const detector = new InlineEquationDetector(its, { fontNameOf: (f) => FONTS.get(f) });
    const r = detector.detect({
      id: 's_2',
      en: 'p (y)',
      sourceSpans: [span(its[0]!, 4, 5), span(its[1]!), span(its[2]!), span(its[3]!)],
    });
    expect(r.equations).toHaveLength(1);
    const e = r.equations[0]!;
    expect(e.rawText).toBe('p (y)');
    expect(e.rects).toHaveLength(2);
    // 'abc p'(폭 25) 중 마지막 글자만: x = 100 + 25 × 4/5, 폭 5
    expect(e.rects[0]!.x).toBeCloseTo(120, 6);
    expect(e.rects[0]!.width).toBeCloseTo(5, 6);
    expect(e.rects[1]!.y).toBeCloseTo(88, 6);
    expect(e.sourceSpans[0]).toMatchObject({ utf16Start: 4, utf16End: 5 });
    expect(r.en).toBe('[EQ_1]');
  });

  it('단어에 붙은 그리스 문자(PanGu-α)와 2글자 단어(of a)는 수식이 아니다', () => {
    const r = detect(
      [{ str: 'PanGu-α' }, sp(), { str: 'of' }, sp(), { str: 'a' }, sp(), { str: 'model' }],
      'PanGu-α of a model',
    );
    expect(r.equations).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it('스팬이 없거나 항목을 모르는 문장은 비어 있는 결과', () => {
    const detector = new InlineEquationDetector([]);
    const r = detector.detect({
      id: 's_3',
      en: 'x',
      sourceSpans: [
        {
          pageIndex: 0,
          textItemId: 'missing',
          utf16Start: 0,
          utf16End: 1,
          normalizedStart: 0,
          normalizedEnd: 1,
          normalizationMapId: 'nm_missing',
        },
      ],
    });
    expect(r).toEqual({
      sentenceId: 's_3',
      en: 'x',
      equations: [],
      signals: [],
      skipped: [],
      warnings: [],
    });
    expect(EQUATION_DETECTOR_VERSION).toBe('1');
  });
});

describe('equationStats', () => {
  it('상태·경고·제외 사유를 센다', () => {
    const a = detect(
      [
        { str: 'p', font: 'MI10' },
        { str: '(', font: 'R10' },
        { str: 'y', font: 'MI10' },
        { str: ')', font: 'R10' },
      ],
      'p(y)',
    );
    const b = detect(
      [{ str: 'x', font: 'MI10' }, { str: ' stores ' }, { str: '∼', font: 'SY10' }],
      'x stores ∼',
    );
    const c = detect(
      [
        { str: 'p', font: 'MI10' },
        { str: '(', font: 'R10' },
        { str: 'y', font: 'MI10' },
        { str: ')', font: 'R10' },
      ],
      'none',
    );
    expect(equationStats([a, b, c])).toEqual({
      sentences: 3,
      sentencesWithEquations: 2,
      equations: 2,
      detected: 1,
      uncertain: 1,
      notInText: 1,
      skippedSingleVariable: 1,
      skippedSingleSymbol: 1,
      skippedNoLetter: 0,
      skippedTextScript: 0,
    });
  });
});
