import type { ContextDocument, ExtractionDocument, GlossaryEntry, Sentence } from '@shared/schema';
import type { PlannedChunk } from '../chunk/chunker';
import type { IdAliases } from '../prompt/aliases';

/**
 * 2차 패스 입력(PLAN 6.2). 청크마다 독립 작업이므로 공통 문맥을 매번 명시적으로 넣는다(PLAN 6.3).
 * 용어집은 이 청크의 대상·문맥 문장에 용어나 별칭이 나오는 항목만 넣는다.
 * 섹션 요약(sectionDigests)은 M3에서 생긴다. 그 전에는 섹션 제목만 넣는다.
 */
export interface ChunkPromptInputs {
  PAPER_CONTEXT: {
    title: string | null;
    summary: string;
    researchQuestion: string;
    methodOverview: string;
    contributions: string[];
  };
  GLOSSARY: {
    term: string;
    aliases: string[];
    preferredKo: string;
    acceptedKo: string[];
    displayRule: string;
    meaningInPaper: string;
  }[];
  /** 개념 카드 목록. 문장 해설이 같은 설명을 되풀이하지 않고 카드로 잇게 한다. */
  CONCEPTS: { id: string; name: string; nameKo: string | null; definitionKo: string }[];
  SECTION_CONTEXT: { title: string; parent: string | null }[];
  NEIGHBOR_CONTEXT: { before: { en: string }[]; after: { en: string }[] } | null;
  TARGET_SENTENCES: {
    id: string;
    en: string;
    equationPlaceholders: string[];
    citationMarkers: string[];
  }[];
}

const isWordChar = (ch: string | undefined): boolean =>
  ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/** 글에 용어가 낱말 단위로 나오는지. 대소문자를 가리지 않는다. 짧은 약어가 다른 낱말 속에서 걸리지 않게 경계를 본다. */
export function mentions(text: string, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (needle === '') return false;
  const hay = text.toLowerCase();
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    const before = at === 0 ? undefined : hay[at - 1];
    const after = hay[at + needle.length];
    const leftOk = !isWordChar(needle[0]) || !isWordChar(before);
    const rightOk = !isWordChar(needle.at(-1)) || !isWordChar(after);
    if (leftOk && rightOk) return true;
  }
  return false;
}

export function relevantGlossary(glossary: GlossaryEntry[], text: string): GlossaryEntry[] {
  return glossary.filter((g) => [g.term, ...g.aliases].some((t) => mentions(text, t)));
}

export function buildChunkInputs(
  document: ExtractionDocument,
  context: ContextDocument,
  chunk: PlannedChunk,
  aliases: IdAliases,
): ChunkPromptInputs {
  const byId = new Map<string, Sentence>(document.sentences.map((s) => [s.id, s]));
  const need = (id: string): Sentence => {
    const sentence = byId.get(id);
    if (!sentence) throw new Error(`청크 ${chunk.id}가 문서에 없는 문장을 가리킵니다: ${id}`);
    return sentence;
  };
  const targets = chunk.targetSentenceIds.map(need);
  const neighbors = chunk.neighborSentenceIds.map(need);
  const firstOrder = targets[0]?.order ?? 0;
  const before = neighbors.filter((s) => s.order < firstOrder);
  const after = neighbors.filter((s) => s.order >= firstOrder);
  const text = [...targets, ...neighbors].map((s) => s.en).join('\n');

  const sectionById = new Map(document.sections.map((s) => [s.id, s]));
  const sections = (chunk.sectionIds.length > 0 ? chunk.sectionIds : [chunk.sectionId])
    .map((id) => sectionById.get(id))
    .filter((s) => s !== undefined)
    .map((s) => ({
      title: s.title,
      parent: s.parentId ? (sectionById.get(s.parentId)?.title ?? null) : null,
    }));

  return {
    PAPER_CONTEXT: {
      title: document.paper.title ?? null,
      summary: context.summary,
      researchQuestion: context.researchQuestion,
      methodOverview: context.methodOverview,
      contributions: context.contributions,
    },
    GLOSSARY: relevantGlossary(context.glossary, text).map((g) => ({
      term: g.term,
      aliases: g.aliases,
      preferredKo: g.preferredKo,
      acceptedKo: g.acceptedKo ?? [],
      displayRule: g.displayRule,
      meaningInPaper: g.meaningInPaper,
    })),
    CONCEPTS: context.concepts.map((c) => ({
      id: c.id,
      name: c.name,
      nameKo: c.nameKo ?? null,
      definitionKo: c.definitionKo,
    })),
    SECTION_CONTEXT: sections,
    // 문맥 문장에는 id를 주지 않는다. 결과에 끼워 넣을 id 자체가 없게 한다.
    NEIGHBOR_CONTEXT:
      neighbors.length === 0
        ? null
        : { before: before.map((s) => ({ en: s.en })), after: after.map((s) => ({ en: s.en })) },
    TARGET_SENTENCES: targets.map((s) => ({
      id: aliases.sentenceAlias(s.id) ?? s.id,
      en: s.en,
      equationPlaceholders: s.equations.map((e) => e.token),
      citationMarkers: s.citationMarkers,
    })),
  };
}
