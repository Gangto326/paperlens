import type { SentenceTranslation, TranslationSnapshot } from '@shared/ipc';
import type { SelectionResult, SentenceIndexEntry } from '@shared/mapping/selection';

/**
 * 우측 패널 뷰 모델(C1.16·C2.9). DOM을 모르는 순수 변환이라 node 환경에서 테스트한다.
 * 문장 원문(`en`)과 매핑 상태, 저장된 번역·해설을 보여준다. 결과가 없는 문장은 "처리 대기"(PLAN 9)다.
 * 번역은 메모리에 든 스냅샷에서만 찾는다. 선택할 때 LLM이나 네트워크를 부르지 않는다.
 */

export const UNMAPPED_NOTICE = '이 부분은 문장 연결을 확인하지 못했습니다';
export const UNCERTAIN_NOTICE = '문장 연결이 불확실합니다. 원문이 화면과 조금 다를 수 있습니다';
export const PENDING_TRANSLATION = '번역·해설: 처리 대기';
export const FAILED_TRANSLATION =
  '번역·해설: 이 부분은 만들지 못했습니다. 번역을 이어서 하면 다시 시도합니다';

export type TranslationView =
  | { state: 'pending' | 'failed'; text: string }
  | {
      state: 'complete';
      ko: string;
      /** 빈 해설은 null. 화면에서 숨긴다. */
      note: string | null;
      warnings: string[];
    };

/** 문장 ID로 저장된 번역을 찾는다. */
export type TranslationLookup = (sentenceId: string) => TranslationView;

export const NO_TRANSLATIONS: TranslationLookup = () => ({
  state: 'pending',
  text: PENDING_TRANSLATION,
});

const WARNING_TEXT: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^number_missing: (.+)$/, (m) => `원문의 수치 ${m[1] ?? ''}가 번역에 그대로 보이지 않습니다`],
];

/** 검증기가 남긴 코드형 경고를 읽을 수 있는 글로 바꾼다. 모델이 쓴 경고는 그대로 둔다. */
export function warningText(warning: string): string {
  for (const [pattern, format] of WARNING_TEXT) {
    const m = pattern.exec(warning);
    if (m) return format(m);
  }
  return warning;
}

export function translationView(found: SentenceTranslation): TranslationView {
  return {
    state: 'complete',
    ko: found.ko,
    note: found.note.trim() === '' ? null : found.note,
    warnings: found.warnings.map(warningText),
  };
}

export function lookupOf(snapshot: TranslationSnapshot | null): TranslationLookup {
  if (!snapshot) return NO_TRANSLATIONS;
  const failed = new Set(
    snapshot.chunks.filter((c) => c.status === 'failed').flatMap((c) => c.sentenceIds),
  );
  return (sentenceId) => {
    const found = snapshot.results[sentenceId];
    if (found) return translationView(found);
    if (failed.has(sentenceId)) return { state: 'failed', text: FAILED_TRANSLATION };
    return { state: 'pending', text: PENDING_TRANSLATION };
  };
}

export interface EnPart {
  kind: 'text' | 'equation';
  text: string;
}

export interface SentenceView {
  id: string;
  /** "#12 · 3쪽" */
  label: string;
  status: SentenceIndexEntry['mappingStatus'];
  statusLabel: string;
  /** unmapped·uncertain일 때 사용자에게 보이는 문구 */
  notice: string | null;
  /** [EQ_n] 자리표시자를 분리한 원문 조각 */
  en: EnPart[];
  translation: TranslationView;
}

export interface SelectionView {
  /** 패널 머리글. 빈 선택이면 이유 문구 */
  summary: string;
  sentences: SentenceView[];
}

const STATUS_LABEL: Record<SentenceIndexEntry['mappingStatus'], string> = {
  mapped: '연결됨',
  uncertain: '불확실',
  unmapped: '미연결',
};

const EMPTY_SUMMARY: Record<Exclude<SelectionResult['reason'], 'ok'>, string> = {
  empty_selection: '',
  whitespace_only: '공백만 선택했습니다.',
  no_sentence: '이 위치에서 문장을 찾지 못했습니다.',
  excluded_block: '본문 문장이 아닌 영역(수식·표·머리글 등)입니다.',
};

const EQ_TOKEN = /\[EQ_\d+\]/g;

/** `en`을 텍스트와 [EQ_n] 조각으로 나눈다. 토큰이 없으면 조각 하나. */
export function splitEquations(en: string): EnPart[] {
  const parts: EnPart[] = [];
  let last = 0;
  for (const m of en.matchAll(EQ_TOKEN)) {
    const at = m.index;
    if (at > last) parts.push({ kind: 'text', text: en.slice(last, at) });
    parts.push({ kind: 'equation', text: m[0] });
    last = at + m[0].length;
  }
  if (last < en.length || parts.length === 0) parts.push({ kind: 'text', text: en.slice(last) });
  return parts;
}

export function sentenceView(
  s: SentenceIndexEntry,
  lookup: TranslationLookup = NO_TRANSLATIONS,
): SentenceView {
  const notice =
    s.mappingStatus === 'unmapped'
      ? UNMAPPED_NOTICE
      : s.mappingStatus === 'uncertain'
        ? UNCERTAIN_NOTICE
        : null;
  return {
    id: s.id,
    label: `#${s.order} · ${s.page + 1}쪽`,
    status: s.mappingStatus,
    statusLabel: STATUS_LABEL[s.mappingStatus],
    notice,
    en: splitEquations(s.en),
    translation: lookup(s.id),
  };
}

export function selectionView(
  result: SelectionResult,
  lookup: TranslationLookup = NO_TRANSLATIONS,
): SelectionView {
  if (result.sentences.length === 0) {
    return {
      summary: EMPTY_SUMMARY[result.reason as keyof typeof EMPTY_SUMMARY] ?? '',
      sentences: [],
    };
  }
  const n = result.sentences.length;
  const byStatus = { mapped: 0, uncertain: 0, unmapped: 0 };
  for (const s of result.sentences) byStatus[s.mappingStatus]++;
  const extra: string[] = [];
  if (byStatus.uncertain) extra.push(`불확실 ${byStatus.uncertain}`);
  if (byStatus.unmapped) extra.push(`미연결 ${byStatus.unmapped}`);
  if (result.byRect) extra.push('위치로 찾음');
  const summary = `문장 ${n}개 선택${extra.length ? ` (${extra.join(', ')})` : ''}`;
  return { summary, sentences: result.sentences.map((s) => sentenceView(s, lookup)) };
}
