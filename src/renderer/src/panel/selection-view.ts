import type { SelectionResult, SentenceIndexEntry } from '@shared/mapping/selection';

/**
 * 우측 패널 뷰 모델(C1.16). DOM을 모르는 순수 변환이라 node 환경에서 테스트한다.
 * 문장 원문(`en`)과 매핑 상태를 보여주고, 번역·해설은 아직 없으므로 "처리 대기"(PLAN 9)로 표시한다.
 */

export const UNMAPPED_NOTICE = '이 부분은 문장 연결을 확인하지 못했습니다';
export const UNCERTAIN_NOTICE = '문장 연결이 불확실합니다. 원문이 화면과 조금 다를 수 있습니다';
export const PENDING_TRANSLATION = '번역·해설: 처리 대기';

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
  translation: string;
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

export function sentenceView(s: SentenceIndexEntry): SentenceView {
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
    translation: PENDING_TRANSLATION,
  };
}

export function selectionView(result: SelectionResult): SelectionView {
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
  return { summary, sentences: result.sentences.map(sentenceView) };
}
