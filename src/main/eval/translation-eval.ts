import type {
  ChunkDocument,
  ContextDocument,
  ExtractionDocument,
  GlossaryEntry,
} from '@shared/schema';
import { sha256Hex, stableStringify } from '../cache/hash';
import { bodySentences } from '../chunk/chunker';
import { mentions } from '../translate/chunk-input';

/**
 * 번역 결과 평가(COMMIT_PLAN C2.11, PLAN 12.3). 저장된 세대 하나를 읽어 두 가지를 센다. 순수 함수다.
 *
 * ID 정합성: 저장된 결과가 추출 문서의 문장과 빠짐없이, 겹치지 않게 대응하는가.
 * 용어 일관성: 원문에 용어집의 대표 용어(term)가 나온 문장의 번역에 그 용어의 정해진 표기가 있는가.
 *   번역에 선호 한국어 표기(preferredKo)가 있거나 원어·별칭이 그대로 있으면 지킨 것으로 본다.
 *   원어를 그대로 두는 것은 용어집의 표기 규칙(첫 등장 뒤 약어 사용 등)이 허용하는 경우가 많아 위반으로 치지 않는다.
 *   별칭(aliases)만 나온 문장은 검사하지 않고 수만 센다. 용어집 항목에는 선호 표기가 하나뿐이고,
 *   별칭의 번역은 표기 규칙 글(displayRule)에 따로 적혀 있어 글자열로 대조할 수 없다.
 *   실제 세대에서 별칭까지 검사하면 `document index` → '문서 색인'처럼 규칙을 따른 번역이 위반으로 나왔다.
 * 이 평가는 글자열 포함 여부만 본다. 뜻이 맞는지, 표기 규칙의 세부(첫 등장에만 병기 등)를 지켰는지는 보지 않는다.
 */
export type IdProblemCode =
  | 'chunk_not_complete'
  | 'result_ids_differ_from_targets'
  | 'unknown_sentence'
  | 'sentence_in_two_chunks'
  | 'sentence_without_result'
  | 'result_hash_mismatch'
  | 'empty_translation';

export interface IdProblem {
  code: IdProblemCode;
  chunkId: string | null;
  sentenceId: string | null;
  detail: string;
}

export interface TermViolation {
  glossaryId: string;
  term: string;
  preferredKo: string;
  sentenceId: string;
  chunkId: string;
  en: string;
  ko: string;
}

export interface TermStat {
  glossaryId: string;
  term: string;
  preferredKo: string;
  /** 원문에 대표 용어가 나온 문장 수 */
  occurrences: number;
  /** 대표 용어는 없고 별칭만 나온 문장 수. 검사하지 않는다. */
  aliasOnly: number;
  /** 번역에 선호 한국어 표기가 있는 문장 수 */
  withPreferred: number;
  /** 선호 표기는 없고 원어·별칭이 그대로 있는 문장 수 */
  withOriginalOnly: number;
  violations: number;
}

export interface TranslationEvaluation {
  sentences: number;
  chunks: number;
  completeChunks: number;
  translated: number;
  idProblems: IdProblem[];
  terms: TermStat[];
  termOccurrences: number;
  /** 별칭만 나와 검사하지 않은 횟수 */
  aliasOnlyOccurrences: number;
  termViolations: TermViolation[];
}

const squeeze = (text: string): string => text.replace(/\s+/g, '').toLowerCase();

const isLatin = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9]/.test(ch);

/**
 * 한국어 번역문에 원어가 그대로 있는지. 조사가 바로 붙으므로(`RAG는`) 한글은 낱말 경계로 본다.
 * 다른 영어 낱말의 일부(`fragment` 안의 `rag`)는 세지 않는다.
 */
export function keepsOriginal(ko: string, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (needle === '') return false;
  const hay = ko.toLowerCase();
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    const before = at === 0 ? undefined : hay[at - 1];
    const after = hay[at + needle.length];
    const leftOk = !isLatin(needle[0]) || !isLatin(before);
    const rightOk = !isLatin(needle.at(-1)) || !isLatin(after);
    if (leftOk && rightOk) return true;
  }
  return false;
}

/** 선호 표기에 괄호 설명이 붙어 있으면(`검색 증강 생성(RAG)`) 괄호 앞부분도 같은 표기로 본다. */
export function preferredForms(entry: Pick<GlossaryEntry, 'preferredKo'>): string[] {
  const full = entry.preferredKo.trim();
  const head = full.replace(/\s*[([（].*$/, '').trim();
  return [...new Set([full, head].filter((f) => f !== ''))];
}

export function evaluateTranslation(input: {
  document: ExtractionDocument;
  context: ContextDocument;
  chunks: readonly ChunkDocument[];
}): TranslationEvaluation {
  const { document, context, chunks } = input;
  const body = bodySentences(document).map((b) => b.sentence);
  const byId = new Map(document.sentences.map((s) => [s.id, s]));
  const idProblems: IdProblem[] = [];
  const problem = (
    code: IdProblemCode,
    chunkId: string | null,
    sentenceId: string | null,
    detail: string,
  ): void => {
    idProblems.push({ code, chunkId, sentenceId, detail });
  };

  const translated = new Map<string, { ko: string; chunkId: string }>();
  let completeChunks = 0;
  for (const chunk of chunks) {
    if (chunk.status !== 'complete') {
      problem('chunk_not_complete', chunk.id, null, `상태 ${chunk.status}`);
      continue;
    }
    completeChunks += 1;
    const ids = chunk.results.map((r) => r.id);
    const same =
      ids.length === chunk.targetSentenceIds.length &&
      ids.every((id, i) => id === chunk.targetSentenceIds[i]);
    if (!same) {
      problem(
        'result_ids_differ_from_targets',
        chunk.id,
        null,
        `대상 ${chunk.targetSentenceIds.length}개, 결과 ${ids.length}개`,
      );
    }
    if (chunk.resultHash !== sha256Hex(stableStringify(chunk.results))) {
      problem('result_hash_mismatch', chunk.id, null, '저장된 resultHash가 결과와 다릅니다');
    }
    for (const r of chunk.results) {
      const sentence = byId.get(r.id);
      if (!sentence) {
        problem('unknown_sentence', chunk.id, r.id, '추출 문서에 없는 문장');
        continue;
      }
      const earlier = translated.get(r.id);
      if (earlier) {
        problem('sentence_in_two_chunks', chunk.id, r.id, `${earlier.chunkId}에도 있습니다`);
        continue;
      }
      if (sentence.en.trim() !== '' && r.ko.trim() === '') {
        problem('empty_translation', chunk.id, r.id, '번역이 비어 있습니다');
      }
      translated.set(r.id, { ko: r.ko, chunkId: chunk.id });
    }
  }
  for (const sentence of body) {
    if (!translated.has(sentence.id)) {
      problem('sentence_without_result', null, sentence.id, `#${sentence.order} 결과가 없습니다`);
    }
  }

  const terms: TermStat[] = [];
  const termViolations: TermViolation[] = [];
  for (const entry of context.glossary) {
    const originals = [entry.term, ...entry.aliases].filter((t) => t.trim() !== '');
    const preferred = preferredForms(entry).map(squeeze);
    const stat: TermStat = {
      glossaryId: entry.id,
      term: entry.term,
      preferredKo: entry.preferredKo,
      occurrences: 0,
      aliasOnly: 0,
      withPreferred: 0,
      withOriginalOnly: 0,
      violations: 0,
    };
    for (const sentence of body) {
      const result = translated.get(sentence.id);
      if (!result) continue;
      if (!mentions(sentence.en, entry.term)) {
        if (entry.aliases.some((t) => mentions(sentence.en, t))) stat.aliasOnly += 1;
        continue;
      }
      stat.occurrences += 1;
      const ko = squeeze(result.ko);
      if (preferred.some((form) => ko.includes(form))) {
        stat.withPreferred += 1;
      } else if (originals.some((t) => keepsOriginal(result.ko, t))) {
        stat.withOriginalOnly += 1;
      } else {
        stat.violations += 1;
        termViolations.push({
          glossaryId: entry.id,
          term: entry.term,
          preferredKo: entry.preferredKo,
          sentenceId: sentence.id,
          chunkId: result.chunkId,
          en: sentence.en,
          ko: result.ko,
        });
      }
    }
    terms.push(stat);
  }

  return {
    sentences: body.length,
    chunks: chunks.length,
    completeChunks,
    translated: translated.size,
    idProblems,
    terms,
    termOccurrences: terms.reduce((n, t) => n + t.occurrences, 0),
    aliasOnlyOccurrences: terms.reduce((n, t) => n + t.aliasOnly, 0),
    termViolations,
  };
}

export function formatEvaluation(e: TranslationEvaluation, limit = 20): string[] {
  const lines = [
    `문장 ${e.sentences}개, 번역 있음 ${e.translated}개, 청크 ${e.completeChunks}/${e.chunks} 완료`,
    `ID 불일치 ${e.idProblems.length}건`,
    ...e.idProblems
      .slice(0, limit)
      .map(
        (p) =>
          `  ${p.code} chunk=${String(p.chunkId)} sentence=${String(p.sentenceId)} ${p.detail}`,
      ),
    `용어 ${e.terms.length}개, 대표 용어 등장 ${e.termOccurrences}회, 위반 ${e.termViolations.length}건, 별칭만 나와 검사하지 않음 ${e.aliasOnlyOccurrences}회`,
  ];
  for (const t of e.terms.filter((x) => x.occurrences > 0)) {
    lines.push(
      `  ${t.term} → ${t.preferredKo}: 등장 ${t.occurrences}, 선호 표기 ${t.withPreferred}, 원어만 ${t.withOriginalOnly}, 위반 ${t.violations}, 별칭만 ${t.aliasOnly}`,
    );
  }
  for (const v of e.termViolations.slice(0, limit)) {
    lines.push(
      `  위반 ${v.term}(${v.preferredKo}) ${v.chunkId}`,
      `    EN ${v.en}`,
      `    KO ${v.ko}`,
    );
  }
  return lines;
}
