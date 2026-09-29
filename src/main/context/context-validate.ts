import type { Concept, Coverage, GlossaryEntry } from '@shared/schema';
import type { ContextInput } from './context-input';
import type { IdAliases } from '../prompt/aliases';
import type { ContextModelCoverage, ContextModelOutput } from './context-output';

/**
 * 1차 패스 출력의 의미 검증(COMMIT_PLAN C2.3). 스키마를 통과한 값에 대해 본다.
 * 실패(problems): 컨텍스트를 저장하지 않는다.
 * - coverage가 입력의 모든 섹션·모든 문장을 덮지 않는다. 모델이 partial·missing이라고 한 범위는 덮은 것으로 치지 않는다.
 * - coverage가 입력에 없는 섹션·문장을 가리키거나 범위가 거꾸로다.
 * - 요약이 비었거나 용어집이 비었다.
 * 참고(notes): 저장은 하되 기록한다. 없는 근거 문장 id와 중복 용어는 버린다.
 * 개념 카드는 이름이나 뜻이 비었거나 이름이 겹치면 버린다. 카드가 가리키는 이름이 없으면 그 연결만 버린다.
 * 개념 카드가 하나도 없어도 실패는 아니다.
 * 서술 글에 프롬프트용 별칭(`s12`, `sec3`)이 남아 있으면 글은 그대로 두고 개수만 기록한다.
 */
export type ContextProblemCode =
  | 'empty_summary'
  | 'empty_glossary'
  | 'unknown_section'
  | 'unknown_sentence'
  | 'sentence_outside_section'
  | 'reversed_range'
  | 'section_not_covered'
  | 'sentences_not_covered';

export interface ContextProblem {
  code: ContextProblemCode;
  message: string;
}

export interface ValidatedContext {
  problems: ContextProblem[];
  notes: string[];
  /** 원래 ID로 되돌린 coverage. jobId는 호출자가 채운다. */
  coverage: Omit<Coverage, 'jobId'>[];
  /** 원래 ID로 되돌린 용어집. id는 `g_<n>`. */
  glossary: GlossaryEntry[];
  /** 개념 카드. id는 `c_<n>`. 출처 없이 쓴 일반 설명이라 researchStatus는 unresolved다. */
  concepts: Concept[];
}

function uniqueTrimmed(items: string[]): string[] {
  return [...new Set(items.map((s) => s.trim()).filter((s) => s !== ''))];
}

/** 글에 든 별칭 모양(`s12`, `sec3`) 중 실제 입력에 있는 것의 수. 본문 기호와 헷갈리지 않게 입력에 있는 것만 센다. */
export function countAliases(text: string, input: ContextInput): number {
  let n = 0;
  for (const m of text.matchAll(/(?<![A-Za-z0-9_])(sec\d+|s\d+)(?![A-Za-z0-9_])/g)) {
    const alias = m[1] ?? '';
    const known = alias.startsWith('sec')
      ? input.aliases.sectionId(alias)
      : input.aliases.sentenceId(alias);
    if (known !== undefined) n += 1;
  }
  return n;
}

/**
 * coverage 장부 검사. `sections`의 모든 섹션과 문장이 covered인 범위에 들어 있어야 한다.
 * 1차 패스 전체에도, 긴 논문의 부분 작업 하나에도 쓴다(COMMIT_PLAN C3.1). 부분 작업에는 그 부분의 섹션만 준다.
 */
export function validateCoverage(
  entries: readonly ContextModelCoverage[],
  sections: ContextInput['sections'],
  aliases: IdAliases,
): { problems: ContextProblem[]; coverage: Omit<Coverage, 'jobId'>[] } {
  const problems: ContextProblem[] = [];
  const add = (code: ContextProblemCode, message: string): void => {
    problems.push({ code, message });
  };
  const sentencesOf = new Map(sections.map((s) => [s.sectionId, s.sentenceIds]));
  const covered = new Map<string, Set<number>>();
  const coverage: Omit<Coverage, 'jobId'>[] = [];
  for (const entry of entries) {
    const sectionId = aliases.sectionId(entry.sectionId);
    const ids = sectionId === undefined ? undefined : sentencesOf.get(sectionId);
    if (sectionId === undefined || ids === undefined) {
      add('unknown_section', `coverage가 입력에 없는 섹션을 가리킵니다: ${entry.sectionId}`);
      continue;
    }
    const start = aliases.sentenceId(entry.startSentenceId);
    const end = aliases.sentenceId(entry.endSentenceId);
    if (start === undefined || end === undefined) {
      add(
        'unknown_sentence',
        `coverage가 입력에 없는 문장을 가리킵니다: ${entry.sectionId} ${entry.startSentenceId}~${entry.endSentenceId}`,
      );
      continue;
    }
    const from = ids.indexOf(start);
    const to = ids.indexOf(end);
    if (from < 0 || to < 0) {
      add(
        'sentence_outside_section',
        `coverage 범위가 그 섹션의 문장이 아닙니다: ${entry.sectionId} ${entry.startSentenceId}~${entry.endSentenceId}`,
      );
      continue;
    }
    if (from > to) {
      add(
        'reversed_range',
        `coverage 범위가 거꾸로입니다: ${entry.sectionId} ${entry.startSentenceId}~${entry.endSentenceId}`,
      );
      continue;
    }
    coverage.push({
      sectionId,
      startSentenceId: start,
      endSentenceId: end,
      status: entry.status,
      warnings: [],
    });
    if (entry.status !== 'covered') continue;
    const set = covered.get(sectionId) ?? new Set<number>();
    for (let i = from; i <= to; i += 1) set.add(i);
    covered.set(sectionId, set);
  }
  for (const section of sections) {
    const alias = aliases.sectionAlias(section.sectionId) ?? section.sectionId;
    const set = covered.get(section.sectionId);
    if (!set) {
      add('section_not_covered', `coverage에 covered인 범위가 없는 섹션: ${alias}`);
      continue;
    }
    const missing = section.sentenceIds.length - set.size;
    if (missing > 0) {
      add(
        'sentences_not_covered',
        `섹션 ${alias}의 문장 ${section.sentenceIds.length}개 중 ${missing}개가 coverage에 없습니다`,
      );
    }
  }
  return { problems, coverage };
}

export function validateContextOutput(
  output: ContextModelOutput,
  input: ContextInput,
): ValidatedContext {
  const problems: ContextProblem[] = [];
  const notes: string[] = [];
  const add = (code: ContextProblemCode, message: string): void => {
    problems.push({ code, message });
  };

  if (output.summary.trim() === '') add('empty_summary', '요약이 비어 있습니다');

  const ledger = validateCoverage(output.coverage, input.sections, input.aliases);
  problems.push(...ledger.problems);
  const coverage = ledger.coverage;

  const glossary: GlossaryEntry[] = [];
  const seen = new Set<string>();
  for (const entry of output.glossary) {
    const term = entry.term.trim();
    const key = term.toLowerCase();
    if (term === '' || entry.preferredKo.trim() === '') {
      notes.push(`용어 또는 한국어 표기가 빈 항목을 버렸습니다: "${entry.term}"`);
      continue;
    }
    if (seen.has(key)) {
      notes.push(`중복 용어를 버렸습니다: ${term}`);
      continue;
    }
    seen.add(key);
    const evidence: string[] = [];
    for (const alias of entry.evidenceSentenceIds) {
      const id = input.aliases.sentenceId(alias);
      if (id === undefined) notes.push(`용어 ${term}의 근거 문장 id가 입력에 없습니다: ${alias}`);
      else if (!evidence.includes(id)) evidence.push(id);
    }
    glossary.push({
      id: `g_${glossary.length + 1}`,
      term,
      aliases: entry.aliases.map((a) => a.trim()).filter((a) => a !== ''),
      preferredKo: entry.preferredKo.trim(),
      acceptedKo: uniqueTrimmed(entry.acceptedKo).filter((ko) => ko !== entry.preferredKo.trim()),
      displayRule: entry.displayRule.trim(),
      meaningInPaper: entry.meaningInPaper.trim(),
      evidenceSentenceIds: evidence,
      conceptIds: [],
    });
  }
  if (glossary.length === 0) add('empty_glossary', '용어집에 쓸 수 있는 항목이 없습니다');

  const kept = output.concepts.filter((c) => {
    if (c.name.trim() !== '' && c.definitionKo.trim() !== '') return true;
    notes.push(`이름 또는 뜻이 빈 개념 카드를 버렸습니다: "${c.name}"`);
    return false;
  });
  const conceptIdOf = new Map<string, string>();
  const concepts: Concept[] = [];
  const links: { prerequisites: string[]; glossaryTerms: string[] }[] = [];
  for (const c of kept) {
    const name = c.name.trim();
    const key = name.toLowerCase();
    if (conceptIdOf.has(key)) {
      notes.push(`중복 개념 카드를 버렸습니다: ${name}`);
      continue;
    }
    const id = `c_${concepts.length + 1}`;
    conceptIdOf.set(key, id);
    const nameKo = c.nameKo.trim();
    const exampleKo = c.exampleKo.trim();
    concepts.push({
      id,
      name,
      nameKo: nameKo === '' ? null : nameKo,
      definitionKo: c.definitionKo.trim(),
      whyItMatters: c.whyItMatters.trim(),
      exampleKo: exampleKo === '' ? null : exampleKo,
      prerequisiteConceptIds: [],
      refs: [],
      researchStatus: 'unresolved',
      contextVersion: 1,
    });
    links.push({ prerequisites: c.prerequisites, glossaryTerms: c.glossaryTerms });
  }
  const glossaryByName = new Map<string, GlossaryEntry>();
  for (const g of glossary) {
    for (const t of [g.term, ...g.aliases]) {
      const key = t.toLowerCase();
      if (!glossaryByName.has(key)) glossaryByName.set(key, g);
    }
  }
  concepts.forEach((concept, i) => {
    for (const raw of uniqueTrimmed(links[i]?.prerequisites ?? [])) {
      const id = conceptIdOf.get(raw.toLowerCase());
      if (id === undefined)
        notes.push(`개념 ${concept.name}의 선행 개념이 카드에 없습니다: ${raw}`);
      else if (id !== concept.id) concept.prerequisiteConceptIds.push(id);
    }
    // 카드가 용어를 적지 않았어도 이름이 같은 용어집 항목에는 잇는다.
    for (const raw of uniqueTrimmed([concept.name, ...(links[i]?.glossaryTerms ?? [])])) {
      const entry = glossaryByName.get(raw.toLowerCase());
      if (entry === undefined) {
        if (raw !== concept.name) {
          notes.push(`개념 ${concept.name}이 가리킨 용어가 용어집에 없습니다: ${raw}`);
        }
      } else if (!entry.conceptIds.includes(concept.id)) entry.conceptIds.push(concept.id);
    }
  });

  const prose = [
    output.summary,
    output.researchQuestion,
    output.methodOverview,
    ...output.contributions,
    ...output.mainResults,
    ...output.limitations,
    ...output.unresolved,
    ...output.glossary.flatMap((g) => [g.meaningInPaper, g.displayRule]),
    ...output.concepts.flatMap((c) => [c.definitionKo, c.whyItMatters, c.exampleKo]),
  ];
  const leaked = prose.reduce((n, text) => n + countAliases(text, input), 0);
  if (leaked > 0) notes.push(`서술 글에 프롬프트용 id가 ${leaked}개 남아 있습니다`);

  return { problems, notes, coverage, glossary, concepts };
}
