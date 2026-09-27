import type { ExtractionDocument } from '@shared/schema';

/**
 * 프롬프트용 짧은 ID. 캐시의 섹션·문장 ID는 해시라 길다(`s_c02a1ac053a1b57…`). 모델에는
 * 읽기 순서로 만든 별칭(`sec3`, `s12`)을 보내고 받은 값은 앱이 원래 ID로 되돌린다.
 * 별칭은 추출 문서에서 정해지므로 같은 extractionRevision이면 항상 같다. 캐시에는 원래 ID만 저장한다.
 */
export interface IdAliases {
  sectionAlias(id: string): string | undefined;
  sentenceAlias(id: string): string | undefined;
  sectionId(alias: string): string | undefined;
  sentenceId(alias: string): string | undefined;
}

export function buildAliases(
  document: Pick<ExtractionDocument, 'sections' | 'sentences'>,
): IdAliases {
  const secTo = new Map<string, string>();
  const secFrom = new Map<string, string>();
  [...document.sections]
    .sort((a, b) => a.order - b.order)
    .forEach((section, i) => {
      const alias = `sec${i + 1}`;
      secTo.set(section.id, alias);
      secFrom.set(alias, section.id);
    });
  const senTo = new Map<string, string>();
  const senFrom = new Map<string, string>();
  [...document.sentences]
    .sort((a, b) => a.order - b.order)
    .forEach((sentence, i) => {
      const alias = `s${i + 1}`;
      senTo.set(sentence.id, alias);
      senFrom.set(alias, sentence.id);
    });
  return {
    sectionAlias: (id) => secTo.get(id),
    sentenceAlias: (id) => senTo.get(id),
    sectionId: (alias) => secFrom.get(alias.trim()),
    sentenceId: (alias) => senFrom.get(alias.trim()),
  };
}
