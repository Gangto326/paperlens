import type { TranslationSnapshot } from './ipc';

export const EXPLANATION_KEYS = [
  'main',
  'caution',
  'plain',
  'role',
  'example',
  'deeper',
  'note',
] as const;
export type AdditionalTarget =
  | { kind: 'section'; sentenceId: string; section: (typeof EXPLANATION_KEYS)[number] }
  | { kind: 'concept'; conceptId: string };

export interface AdditionalExplanation {
  pdfSha256: string;
  target: AdditionalTarget;
  /** 원 해설이 바뀌면 이전 답변을 새 해설의 답변으로 표시하지 않는다. */
  source: string;
  status: 'running' | 'complete' | 'failed';
  /** 검증이 끝난 최종 답변. 저장 재시도는 이 값만 사용한다. */
  text: string | null;
  /** 생성 중 표시하는 미완성 답변. 완료 캐시에는 저장하지 않는다. */
  previewText?: string | undefined;
  message: string;
  startedAt: number;
  updatedAt: number;
}

export function parseAdditionalTarget(value: unknown): AdditionalTarget {
  if (!value || typeof value !== 'object') throw new Error('설명 대상을 확인할 수 없습니다.');
  const t = value as Record<string, unknown>;
  const id = t['kind'] === 'concept' ? t['conceptId'] : t['sentenceId'];
  if (typeof id !== 'string' || !id || id.length > 300)
    throw new Error('설명 대상을 확인할 수 없습니다.');
  if (t['kind'] === 'concept') return { kind: 'concept', conceptId: id };
  if (t['kind'] === 'section' && EXPLANATION_KEYS.some((key) => key === t['section']))
    return {
      kind: 'section',
      sentenceId: id,
      section: t['section'] as (typeof EXPLANATION_KEYS)[number],
    };
  throw new Error('설명 대상을 확인할 수 없습니다.');
}

/** renderer와 main이 같은 저장된 해설을 가리키는지 비교하는 값. 경로로 사용하지 않는다. */
export function additionalSource(
  snapshot: TranslationSnapshot,
  target: AdditionalTarget,
): string | null {
  if (target.kind === 'concept') {
    if (!Object.hasOwn(snapshot.concepts ?? {}, target.conceptId)) return null;
    const card = snapshot.concepts?.[target.conceptId];
    if (!card) return null;
    return JSON.stringify({
      name: card.name,
      nameKo: card.nameKo,
      definition: card.definitionKo,
      whyItMatters: card.whyItMatters,
      example: card.exampleKo,
      prerequisites: card.prerequisiteConceptIds,
    });
  }
  if (!Object.hasOwn(snapshot.results, target.sentenceId)) return null;
  const sentence = snapshot.results[target.sentenceId];
  const text = target.section === 'note' ? sentence?.note : sentence?.explanation?.[target.section];
  if (!sentence || !text?.trim()) return null;
  return JSON.stringify({
    translation: sentence.ko,
    section: target.section,
    explanation: text,
  });
}

export function additionalKey(target: AdditionalTarget, source: string): string {
  return JSON.stringify([target, source]);
}
