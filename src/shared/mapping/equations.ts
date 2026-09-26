import type {
  EquationDetectionStatus,
  EquationPlaceholder,
  Rect,
  Sentence,
  SourceSpan,
  TextItemRecord,
} from '@shared/schema/types';
import { COORD_TRANSFORM_VERSION, textItemToUserRect } from '../geometry/coords';
import { normalizeText } from '../normalize/normalizer';

/**
 * 인라인 수식 후보 검출 규칙의 버전(extraction revision 입력 후보). 신호·병합·판정 규칙이 바뀌면 올린다.
 * v1: 문장의 SourceSpan(C1.12)을 항목 단위로 훑어 네 가지 신호를 본다.
 *     - font: 실제 글꼴 이름이 수학 글꼴(CMMI·CMSY·CMEX·MSAM·… ) — 강한 신호. 글꼴 표가 없으면 쓰지 않는다.
 *     - symbol: 수학 기호(Unicode Sm) 또는 그리스 문자 — 강한 신호.
 *     - script: 첨자 위치(높이 ≤ 0.85×본문, 기준선 차 ≥ 0.08×본문) — 강한 신호.
 *     - glyph: 글자 1~2개짜리 항목(TeX는 수식 글리프를 항목 하나씩 낸다) 또는 짧은 이탤릭 항목 — 약한 신호.
 *     신호 항목이 이어지면 하나의 후보로 묶되 사이의 접착 항목(공백·괄호·연산자·숫자 ≤3자)을 흡수한다.
 *     단일 변수(글자 하나), 텍스트 글꼴 첨자(BERT_BASE·각주 숫자)는 후보에서 뺀다(PLAN 5.4).
 *     강한 신호 종류가 둘 이상이거나 수학 글꼴 항목이 둘 이상이면 detected, 그 외는 math_uncertain.
 *     후보 원문을 정규화·공백 제거·대시 통일해 문장 en에서 순서대로 찾아 [EQ_n]으로 치환한다. 못 찾으면
 *     치환하지 않고 warning을 남긴다(LLM이 위치를 지어내지 않도록 원문·좌표만 보존).
 */
export const EQUATION_DETECTOR_VERSION = '1';

/** 서브셋 접두(ABCDEF+)를 뗀 실제 글꼴 이름이 수학 글꼴인지. CMR(로만)·CMBX는 본문 글꼴이라 넣지 않는다. */
const MATH_FONT_RE =
  /^(CM(MI|SY|EX|BSY|MIB)|MSAM|MSBM|rsfs|eu(fm|fb|rm|sm|ex)|LMMath|CambriaMath|STIX\w*Math|XITSMath|LatinModernMath|(tx|px)(sy|mi|ex)|wasy|stmary|dsrom|bbm|AsanaMath|TeXGyre\w*Math|Symbol$)/i;
/** 텍스트 이탤릭 글꼴(변수를 이탤릭 본문 글꼴로 조판한 PDF의 약한 신호). */
const ITALIC_FONT_RE = /Ital|Oblique|Slanted|-It$|(^|\+|-)TI\d{4}|(^|-)It(\b|\d)/i;
const SUBSET_PREFIX_RE = /^[A-Z]{6}\+/;
/** 수학 기호: Unicode Sm(=, +, |, <, >, ~ 포함) 또는 그리스 문자. 하이픈·괄호·마침표는 아니다. */
const MATH_SYMBOL_RE = /[\p{Sm}\p{Script=Greek}]/u;
const LETTER_RE = /\p{L}/u;
const LETTERS_ONLY_RE = /^\p{L}+$/u;
const DIGITS_ONLY_RE = /^[\d.,]+$/u;
/** 접착 항목: 공백뿐이거나, 괄호·구두점·연산자·숫자만 3자 이하. */
const GLUE_RE = /^[\s\d(),.;:|=+\-−*/^_'′″<>[\]{}·]{0,3}$/u;
const WORD_RE = /\p{L}{3,}/gu;
const DASH_RE = /[‐‑‒–—−­]/gu;
/** 가운뎃점 계열(·, •, ∙, ⋅): GROBID와 PDF.js가 다른 코드를 낼 수 있어 위치 찾기에서만 하나로 본다. */
const DOT_RE = /[\u00B7\u2022\u2219\u22C5]/gu;
/** 끝이 닫는 괄호인 접착 항목(")", "10}"). */
const CLOSING_RE = /[)\]}]$/u;
const SENTENCE_PUNCT_RE = /^[.,;:]+$/u;
/** 로만체로 조판되는 수학 함수 이름. 강한 신호 사이에 오면 후보에 흡수한다(log p(y|x)). */
const MATH_WORD_RE =
  /^(log|ln|exp|max|min|arg|argmax|argmin|sin|cos|tan|softmax|lim|sup|inf|det|tr|dim)$/iu;

export type EquationSkipKind =
  /** 글자 하나뿐인 후보(변수 x·θ). 자리표시자로 바꾸지 않고 본문에 둔다. */
  | 'single_variable'
  /** 기호 하나뿐인 후보(∼, ≈). 본문에 둔다. */
  | 'single_symbol'
  /** 글자(라틴·그리스)가 하나도 없는 후보(인용 키 첨자 "+24", "∼ 100"). 본문에 둔다. */
  | 'no_letter'
  /** 첨자 위치뿐인 텍스트 글꼴 단어·숫자(BERT_BASE, 각주 표시). */
  | 'text_script';

export interface EquationSignals {
  font: number;
  symbol: number;
  script: number;
  weak: number;
}

export interface EquationDetection {
  sentenceId: string;
  /** 후보를 [EQ_n]으로 치환한 문장 텍스트. 못 찾은 후보는 그대로 둔다. */
  en: string;
  equations: EquationPlaceholder[];
  /** equations와 같은 순서의 신호 집계(판정 근거 기록용). */
  signals: EquationSignals[];
  skipped: { kind: EquationSkipKind; rawText: string }[];
  warnings: string[];
}

export interface EquationDetectorOptions {
  /** 항목 fontName → 실제 글꼴 이름(서브셋 접두 포함 가능). 모르면 undefined 또는 ''. 없으면 font 신호를 쓰지 않는다. */
  fontNameOf?: (fontName: string) => string | undefined;
  /** 첨자 판정: 높이 비 상한과 기준선 차 하한(본문 높이 대비). */
  scriptHeightRatio?: number;
  scriptBaselineRatio?: number;
}

interface Unit {
  span: SourceSpan;
  item: TextItemRecord;
  text: string;
  trimmed: string;
  rect: Rect;
  baseline: number;
  height: number;
  mathFont: boolean;
  italicFont: boolean;
  symbol: boolean;
  script: boolean;
  glyph: boolean;
  prose: boolean;
  glue: boolean;
}

function fold(s: string): { text: string; map: number[] } {
  const norm = normalizeText(s).text;
  let text = '';
  const map: number[] = [];
  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i]!;
    if (/\s/u.test(ch)) continue;
    text += ch.replace(DASH_RE, '-').replace(DOT_RE, '·');
    map.push(i);
  }
  return { text, map };
}

/** 가중 최빈값(가중치 = 글자 수). 후보가 없으면 0. */
function weightedMode(units: readonly Unit[]): number {
  const w = new Map<number, number>();
  for (const u of units) {
    if (u.height <= 0 || u.trimmed === '') continue;
    const h = Math.round(u.height * 10) / 10;
    w.set(h, (w.get(h) ?? 0) + u.trimmed.length);
  }
  let best = 0;
  let bestW = -1;
  for (const [h, n] of w) {
    if (n > bestW || (n === bestW && h > best)) {
      best = h;
      bestW = n;
    }
  }
  return best;
}

function unionRect(rects: readonly Rect[]): Rect {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.width));
  const y1 = Math.max(...rects.map((r) => r.y + r.height));
  return {
    pageIndex: rects[0]!.pageIndex,
    x: x0,
    y: y0,
    width: x1 - x0,
    height: y1 - y0,
    coordinateSpace: 'pdf_user_space',
    transformVersion: COORD_TRANSFORM_VERSION,
  };
}

/** 항목 전체 user space 사각형에서 스팬 구간만큼 가로로 잘라낸다(가로 글 기준 비례 절단). */
function spanRect(item: TextItemRecord, span: SourceSpan): Rect {
  const full = textItemToUserRect(item);
  const len = item.str.length;
  if (len === 0 || (span.utf16Start === 0 && span.utf16End === len)) {
    return {
      ...full,
      coordinateSpace: 'pdf_user_space',
      transformVersion: COORD_TRANSFORM_VERSION,
    };
  }
  const a = span.utf16Start / len;
  const b = span.utf16End / len;
  return {
    ...full,
    x: full.x + full.width * a,
    width: full.width * (b - a),
    coordinateSpace: 'pdf_user_space',
    transformVersion: COORD_TRANSFORM_VERSION,
  };
}

export class InlineEquationDetector {
  private readonly itemsById = new Map<string, TextItemRecord>();
  private readonly fontNameOf: (fontName: string) => string | undefined;
  private readonly hasFonts: boolean;
  private readonly scriptHeightRatio: number;
  private readonly scriptBaselineRatio: number;

  constructor(items: Iterable<TextItemRecord>, opts: EquationDetectorOptions = {}) {
    for (const item of items) this.itemsById.set(item.id, item);
    this.hasFonts = opts.fontNameOf !== undefined;
    this.fontNameOf = opts.fontNameOf ?? (() => undefined);
    this.scriptHeightRatio = opts.scriptHeightRatio ?? 0.85;
    this.scriptBaselineRatio = opts.scriptBaselineRatio ?? 0.08;
  }

  private realFont(item: TextItemRecord): string {
    return (this.fontNameOf(item.fontName) ?? '').replace(SUBSET_PREFIX_RE, '');
  }

  private makeUnits(spans: readonly SourceSpan[]): Unit[] {
    const units: Unit[] = [];
    for (const span of spans) {
      const item = this.itemsById.get(span.textItemId);
      if (!item) continue;
      const text = item.str.slice(span.utf16Start, span.utf16End);
      const trimmed = text.trim();
      const rect = spanRect(item, span);
      const font = this.realFont(item);
      const words = trimmed.match(WORD_RE) ?? [];
      const cps = [...trimmed];
      units.push({
        span,
        item,
        text,
        trimmed,
        rect,
        baseline: item.transform[5],
        height: item.height,
        mathFont: this.hasFonts && MATH_FONT_RE.test(font),
        italicFont: ITALIC_FONT_RE.test(font),
        // 단어(3글자 이상)가 붙은 기호(PanGu-α)는 이름이지 수식이 아니다.
        symbol: words.length === 0 && MATH_SYMBOL_RE.test(trimmed),
        script: false,
        // 글자 하나짜리 항목(TeX 수식 글리프). 2글자 단어(of·a)는 세지 않는다.
        glyph: cps.length === 1 && LETTER_RE.test(trimmed),
        prose: words.length >= 2,
        // 접착 여부는 첨자 판정 뒤 확정한다(첨자·수학 글꼴 항목은 접착이 아니다).
        glue: GLUE_RE.test(trimmed) || MATH_WORD_RE.test(trimmed),
      });
    }
    return units;
  }

  /** 같은 줄의 본문 크기 항목을 기준으로 첨자 위치를 판정한다. */
  private markScripts(units: Unit[], bodyH: number): void {
    if (bodyH <= 0) return;
    const isBody = (u: Unit): boolean => u.height >= bodyH * 0.95 && u.trimmed !== '';
    const sameLine = (a: Unit, b: Unit): boolean =>
      a.item.pageIndex === b.item.pageIndex && Math.abs(a.baseline - b.baseline) < bodyH * 1.5;
    units.forEach((u, i) => {
      if (u.trimmed === '' || u.height <= 0 || u.height > bodyH * this.scriptHeightRatio) return;
      let ref: Unit | undefined;
      for (let j = i - 1; j >= 0 && !ref; j--) {
        if (!sameLine(units[j]!, u)) break;
        if (isBody(units[j]!)) ref = units[j];
      }
      for (let j = i + 1; j < units.length && !ref; j++) {
        if (!sameLine(units[j]!, u)) break;
        if (isBody(units[j]!)) ref = units[j];
      }
      if (ref && Math.abs(u.baseline - ref.baseline) >= bodyH * this.scriptBaselineRatio)
        u.script = true;
    });
  }

  detect(sentence: Pick<Sentence, 'id' | 'en' | 'sourceSpans'>): EquationDetection {
    const warnings: string[] = [];
    const units = this.makeUnits(sentence.sourceSpans);
    const bodyH = weightedMode(units);
    this.markScripts(units, bodyH);
    for (const u of units) u.glue = u.glue && !u.script && !u.mathFont;

    // 글리프 단위로 쪼개진 문서(단어까지 글자별 항목)에서는 glyph 신호를 끈다: 글자 하나짜리 항목에 든 글자가
    // 문장 글자의 절반을 넘으면 그렇게 본다(수식 글리프 몇 개로는 넘지 않는다).
    const nonGlue = units.filter((u) => !u.glue);
    const letters = (u: Unit): number => (u.trimmed.match(/\p{L}/gu) ?? []).length;
    const glyphUnits = nonGlue.filter((u) => u.glyph);
    const glyphLetters = glyphUnits.reduce((n, u) => n + letters(u), 0);
    const totalLetters = nonGlue.reduce((n, u) => n + letters(u), 0);
    const glyphFragmented = glyphUnits.length >= 4 && glyphLetters > totalLetters / 2;
    if (glyphFragmented) warnings.push('glyph_fragmented_sentence');

    const strong = (u: Unit): boolean => !u.prose && (u.mathFont || u.symbol || u.script);
    const weak = (u: Unit): boolean =>
      !u.prose &&
      !u.glue &&
      !glyphFragmented &&
      (u.glyph || (u.italicFont && [...u.trimmed].length <= 2 && LETTER_RE.test(u.trimmed)));

    const runs: Unit[][] = [];
    let run: Unit[] | null = null;
    for (const u of units) {
      if (run) {
        if (strong(u) || weak(u) || u.glue) {
          run.push(u);
          continue;
        }
        runs.push(run);
        run = null;
      }
      if (strong(u) || weak(u)) run = [u];
    }
    if (run) runs.push(run);

    const equations: EquationPlaceholder[] = [];
    const signals: EquationSignals[] = [];
    const skipped: EquationDetection['skipped'] = [];
    const placements: { start: number; end: number; token: string }[] = [];
    const folded = fold(sentence.en);
    let cursor = 0;

    for (const r of runs) {
      trimTrailingGlue(r);
      if (r.length === 0) continue;
      const strongUnits = r.filter(strong);
      const weakUnits = r.filter((u) => !strong(u) && weak(u));
      if (strongUnits.length === 0 && weakUnits.length < 2) continue;

      const rawText = joinUnits(r);
      const compact = rawText.replace(/\s+/gu, '');
      const kinds = new Set<'font' | 'symbol' | 'script'>();
      for (const u of strongUnits) {
        if (u.mathFont) kinds.add('font');
        if (u.symbol) kinds.add('symbol');
        if (u.script) kinds.add('script');
      }
      const content = r.filter((u) => !u.glue);
      if (
        kinds.size === 1 &&
        kinds.has('script') &&
        content.every(
          (u) =>
            !u.mathFont &&
            (LETTERS_ONLY_RE.test(u.trimmed)
              ? u.trimmed.length >= 2
              : DIGITS_ONLY_RE.test(u.trimmed)),
        )
      ) {
        skipped.push({ kind: 'text_script', rawText });
        continue;
      }
      if ([...compact].length === 1) {
        skipped.push({
          kind: LETTER_RE.test(compact) ? 'single_variable' : 'single_symbol',
          rawText,
        });
        continue;
      }
      if (!LETTER_RE.test(compact)) {
        skipped.push({ kind: 'no_letter', rawText });
        continue;
      }

      const mathFontUnits = strongUnits.filter((u) => u.mathFont).length;
      let detectionStatus: EquationDetectionStatus =
        kinds.size >= 2 || mathFontUnits >= 2 ? 'detected' : 'math_uncertain';
      let warning: string | null = null;

      const token = `[EQ_${equations.length + 1}]`;
      const key = fold(rawText).text;
      const at = key === '' ? -1 : folded.text.indexOf(key, cursor);
      if (at >= 0) {
        const start = folded.map[at]!;
        const end = folded.map[at + key.length - 1]! + 1;
        placements.push({ start, end, token });
        cursor = at + key.length;
      } else {
        detectionStatus = 'math_uncertain';
        warning = 'not_in_sentence_text';
      }

      const lines: Unit[][] = [];
      for (const u of r) {
        const last = lines[lines.length - 1];
        const prev = last?.[last.length - 1];
        if (
          prev &&
          prev.item.pageIndex === u.item.pageIndex &&
          Math.abs(prev.baseline - u.baseline) <= Math.max(bodyH, 1)
        )
          last.push(u);
        else lines.push([u]);
      }
      signals.push({
        font: mathFontUnits,
        symbol: strongUnits.filter((u) => u.symbol).length,
        script: strongUnits.filter((u) => u.script).length,
        weak: weakUnits.length,
      });
      equations.push({
        id: `${sentence.id}_eq${equations.length + 1}`,
        token,
        rawText,
        sourceSpans: r.map((u) => u.span),
        rects: lines.map((line) => unionRect(line.map((u) => u.rect))),
        detectionStatus,
        warning,
      });
    }

    let en = '';
    let pos = 0;
    for (const p of placements) {
      en += sentence.en.slice(pos, p.start) + p.token;
      pos = p.end;
    }
    en += sentence.en.slice(pos);
    return { sentenceId: sentence.id, en, equations, signals, skipped, warnings };
  }
}

function bracketBalance(units: readonly Unit[]): number {
  let n = 0;
  for (const u of units) {
    for (const ch of u.trimmed) {
      if (ch === '(' || ch === '[' || ch === '{') n++;
      else if (ch === ')' || ch === ']' || ch === '}') n--;
    }
  }
  return n;
}

/**
 * 후보 끝의 접착 항목을 떼되, 짝이 맞는 닫는 괄호와 수학 항목 바로 뒤의 숫자(≈ 0, i−1)는 남긴다.
 * 공백·문장 구두점·여는 괄호·연산자는 뗀다.
 */
function trimTrailingGlue(r: Unit[]): void {
  while (r.length > 0) {
    const u = r[r.length - 1]!;
    const t = u.trimmed;
    if (SENTENCE_PUNCT_RE.test(t) || t === '') {
      r.pop();
      continue;
    }
    if (!u.glue) return;
    if (CLOSING_RE.test(t)) {
      if (bracketBalance(r.slice(0, -1)) > 0) return;
    } else if (DIGITS_ONLY_RE.test(t)) {
      let j = r.length - 2;
      while (j >= 0 && r[j]!.trimmed === '') j--;
      const prev = j >= 0 ? r[j] : undefined;
      if (prev && (prev.symbol || prev.mathFont || prev.script)) return;
    }
    r.pop();
  }
}

/** 후보 항목 원문을 이어 붙인다(항목 사이는 줄바꿈·index 건너뜀일 때만 공백). */
function joinUnits(units: readonly Unit[]): string {
  let out = '';
  let prev: TextItemRecord | undefined;
  for (const u of units) {
    if (
      prev &&
      (prev.hasEOL || prev.pageIndex !== u.item.pageIndex || u.item.index !== prev.index + 1)
    )
      out += ' ';
    out += u.text;
    prev = u.item;
  }
  return out.trim();
}

export interface EquationStats {
  sentences: number;
  sentencesWithEquations: number;
  equations: number;
  detected: number;
  uncertain: number;
  notInText: number;
  skippedSingleVariable: number;
  skippedSingleSymbol: number;
  skippedNoLetter: number;
  skippedTextScript: number;
}

export function equationStats(results: readonly EquationDetection[]): EquationStats {
  const st: EquationStats = {
    sentences: results.length,
    sentencesWithEquations: 0,
    equations: 0,
    detected: 0,
    uncertain: 0,
    notInText: 0,
    skippedSingleVariable: 0,
    skippedSingleSymbol: 0,
    skippedNoLetter: 0,
    skippedTextScript: 0,
  };
  for (const r of results) {
    if (r.equations.length > 0) st.sentencesWithEquations++;
    for (const e of r.equations) {
      st.equations++;
      if (e.detectionStatus === 'detected') st.detected++;
      else st.uncertain++;
      if (e.warning === 'not_in_sentence_text') st.notInText++;
    }
    for (const s of r.skipped) {
      if (s.kind === 'single_variable') st.skippedSingleVariable++;
      else if (s.kind === 'single_symbol') st.skippedSingleSymbol++;
      else if (s.kind === 'no_letter') st.skippedNoLetter++;
      else st.skippedTextScript++;
    }
  }
  return st;
}
