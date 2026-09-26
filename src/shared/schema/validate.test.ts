import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import { CACHE_SCHEMAS } from './json-schema';
import { validateCacheDocument } from './validate';
import {
  sampleBudget,
  sampleChunk,
  sampleContext,
  sampleExtraction,
  sampleManifest,
  sampleResearch,
  sampleSourceMap,
} from './fixtures';

describe('캐시 스키마 v1', () => {
  it('모든 스키마가 ajv strict 모드에서 컴파일된다', () => {
    const ajv = new Ajv({ strict: true, allowUnionTypes: true });
    for (const [name, schema] of Object.entries(CACHE_SCHEMAS)) {
      expect(() => ajv.compile(schema), name).not.toThrow();
    }
  });

  it('유효한 샘플은 통과한다', () => {
    expect(validateCacheDocument('manifest', sampleManifest).ok).toBe(true);
    expect(validateCacheDocument('extractionDocument', sampleExtraction).ok).toBe(true);
    expect(validateCacheDocument('sourceMapDocument', sampleSourceMap).ok).toBe(true);
    expect(validateCacheDocument('contextDocument', sampleContext).ok).toBe(true);
    expect(validateCacheDocument('researchDocument', sampleResearch).ok).toBe(true);
    expect(validateCacheDocument('budgetDocument', sampleBudget).ok).toBe(true);
    expect(validateCacheDocument('chunkDocument', sampleChunk).ok).toBe(true);
  });

  it('알 수 없는 필드는 거부한다 (additionalProperties: false)', () => {
    const r = validateCacheDocument('chunkDocument', { ...sampleChunk, extra: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('additional properties');
  });

  it('필수 필드 누락과 enum 위반을 거부한다', () => {
    const { state: _s, ...noState } = sampleManifest;
    expect(validateCacheDocument('manifest', noState).ok).toBe(false);
    expect(validateCacheDocument('manifest', { ...sampleManifest, state: 'done' }).ok).toBe(false);
    expect(validateCacheDocument('manifest', { ...sampleManifest, schemaVersion: 2 }).ok).toBe(
      false,
    );
  });

  it('문장 결과에 URL 필드가 들어오면 거부한다 (refs는 Source ID만)', () => {
    const bad = {
      ...sampleChunk,
      results: [
        {
          id: 's_1',
          ko: '번역',
          note: '',
          refs: [{ url: 'https://x' }],
          conceptIds: [],
          warnings: [],
        },
      ],
    };
    expect(validateCacheDocument('chunkDocument', bad).ok).toBe(false);
  });

  it('수식 자리표시자 토큰 형식을 강제한다', () => {
    const s = sampleExtraction.sentences[0]!;
    const withEq = {
      ...sampleExtraction,
      sentences: [
        {
          ...s,
          equations: [
            { id: 'eq_1', token: 'EQ1', sourceSpans: [], rects: [], detectionStatus: 'detected' },
          ],
        },
      ],
    };
    expect(validateCacheDocument('extractionDocument', withEq).ok).toBe(false);
  });
});
