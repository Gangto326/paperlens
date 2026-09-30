import type { TranslationSnapshot } from '@shared/ipc';
import { parseRichText, type RichBlock } from './rich-text';
import { conceptView, type ConceptView } from './selection-view';

/**
 * 개요·용어집·개념 카드 패널의 뷰 모델(COMMIT_PLAN C3.7, PLAN 9절). DOM을 모르는 순수 변환이다.
 * 1차 패스가 끝나 context.json이 생기면 번역이 끝나기 전에도 보인다. 컨텍스트가 없으면 null이다.
 * 글이 없는 항목은 넣지 않는다.
 */
export interface OverviewItem {
  label: string;
  blocks: RichBlock[];
}

export interface GlossaryRow {
  /** "fine-tuning (FT)" */
  term: string;
  /** "파인튜닝 · 미세 조정" */
  ko: string;
  meaning: string;
}

export interface OverviewView {
  items: OverviewItem[];
  glossary: GlossaryRow[];
  concepts: ConceptView[];
}

const listText = (items: readonly string[]): string => items.map((s) => `- ${s}`).join('\n');

export function overviewView(snapshot: TranslationSnapshot | null): OverviewView | null {
  const overview = snapshot?.overview ?? null;
  if (!snapshot || !overview) return null;
  const items: OverviewItem[] = [];
  const add = (label: string, text: string): void => {
    if (text.trim() !== '') items.push({ label, blocks: parseRichText(text) });
  };
  add('요약', overview.summary);
  add('풀려는 문제', overview.researchQuestion);
  add('방법', overview.methodOverview);
  add('기여', listText(overview.contributions));
  add('주요 결과', listText(overview.mainResults));
  add('한계', listText(overview.limitations));
  add('확인하지 못한 것', listText(overview.unresolved));
  const glossary = overview.glossary.map((g) => ({
    term: g.aliases.length > 0 ? `${g.term} (${g.aliases.join(', ')})` : g.term,
    ko: [g.preferredKo, ...g.acceptedKo].join(' · '),
    meaning: g.meaningInPaper,
  }));
  const concepts = snapshot.concepts ?? {};
  return {
    items,
    glossary,
    concepts: Object.values(concepts).map((c) => conceptView(c, concepts)),
  };
}
