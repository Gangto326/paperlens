import type { ExtractionDocument, Section, Sentence } from '@shared/schema';
import { buildAliases, type IdAliases } from '../prompt/aliases';

/**
 * 1차 패스 입력(PLAN 6.1). 문장이 있는 섹션만 읽기 순서로 넣는다.
 * 제외 블록(표·그림·독립 수식)은 넣지 않는다. 문장 글은 자리표시자가 들어간 `en`이다.
 */
export interface ContextBodySection {
  id: string;
  title: string;
  /** 상위 섹션 제목. 없으면 null. */
  parent: string | null;
  sentences: { id: string; en: string }[];
}

export interface ContextInput {
  metadata: { title: string | null; authors: string[]; year: number | null; pageCount: number };
  body: ContextBodySection[];
  aliases: IdAliases;
  /** 입력에 들어간 섹션(원래 ID)과 그 문장(원래 ID, 읽기 순서). coverage 검증의 기준이다. */
  sections: { sectionId: string; sentenceIds: string[] }[];
  sentenceCount: number;
  /** 본문 글자 수 / 4. 분할 여부 판단용 근사치다. */
  estimatedTokens: number;
}

/** 영어 본문의 토큰 수 근사. 토크나이저 없이 글자 수로만 본다. */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 4);

export function buildContextInput(document: ExtractionDocument): ContextInput {
  const aliases = buildAliases(document);
  const byId = new Map<string, Sentence>(document.sentences.map((s) => [s.id, s]));
  const sectionById = new Map<string, Section>(document.sections.map((s) => [s.id, s]));
  const body: ContextBodySection[] = [];
  const sections: ContextInput['sections'] = [];
  let chars = 0;
  let sentenceCount = 0;
  for (const section of [...document.sections].sort((a, b) => a.order - b.order)) {
    const sentences = section.sentenceIds
      .map((id) => byId.get(id))
      .filter((s): s is Sentence => s !== undefined)
      .sort((a, b) => a.order - b.order);
    if (sentences.length === 0) continue;
    const parent = section.parentId ? sectionById.get(section.parentId) : undefined;
    body.push({
      id: aliases.sectionAlias(section.id) ?? section.id,
      title: section.title,
      parent: parent ? parent.title : null,
      sentences: sentences.map((s) => ({ id: aliases.sentenceAlias(s.id) ?? s.id, en: s.en })),
    });
    sections.push({ sectionId: section.id, sentenceIds: sentences.map((s) => s.id) });
    for (const s of sentences) chars += s.en.length;
    sentenceCount += sentences.length;
  }
  return {
    metadata: {
      title: document.paper.title ?? null,
      authors: document.paper.authors,
      year: document.paper.year ?? null,
      pageCount: document.paper.pageCount,
    },
    body,
    aliases,
    sections,
    sentenceCount,
    estimatedTokens: estimateTokens(chars),
  };
}
