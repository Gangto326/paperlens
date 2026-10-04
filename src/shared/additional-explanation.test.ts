import { expect, it } from 'vitest';
import { additionalKey, additionalSource, parseAdditionalTarget } from './additional-explanation';
import type { TranslationSnapshot } from './ipc';

const snapshot: TranslationSnapshot = {
  pdfSha256: 'a'.repeat(64),
  state: 'complete',
  generationId: 'g1',
  chunks: [],
  results: {
    s1: {
      ko: '번역',
      note: '이전 해설',
      warnings: [],
      chunkId: 'c1',
      explanation: {
        main: '기존 해설',
        example: '예시',
        caution: '주의',
        plain: '',
        role: '',
        deeper: '',
      },
    },
  },
};
it('해설과 예시의 저장 키를 분리하며 다른 세대에서도 같은 해설은 유지한다', () => {
  const target = parseAdditionalTarget({ kind: 'section', sentenceId: 's1', section: 'main' });
  const source = additionalSource(snapshot, target)!;
  expect(source).toContain('기존 해설');
  expect(additionalSource({ ...snapshot, generationId: 'g2' }, target)).toBe(source);
  const example = parseAdditionalTarget({ kind: 'section', sentenceId: 's1', section: 'example' });
  expect(additionalKey(target, source)).not.toBe(
    additionalKey(example, additionalSource(snapshot, example)!),
  );
  expect(additionalSource(snapshot, { kind: 'concept', conceptId: 'missing' })).toBeNull();
});
it('허용하지 않은 대상과 임의 해설 키를 거부한다', () => {
  for (const target of [
    null,
    {},
    { kind: 'section', sentenceId: 's1', section: '__proto__' },
    { kind: 'file', sentenceId: 's1' },
    { kind: 'concept', conceptId: '' },
  ]) {
    expect(() => parseAdditionalTarget(target)).toThrow();
  }
});
