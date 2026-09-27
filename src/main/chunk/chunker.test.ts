import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Section, Sentence } from '@shared/schema';
import { bodySentences, chunkInputHash, planChunks, type PlannedChunk } from './chunker';

interface Doc {
  sections: Section[];
  sentences: Sentence[];
}

/** spec[i][j][k] = i번째 섹션, j번째 문단, k번째 문장의 토큰 수(글자 수는 4배). */
const makeDoc = (spec: number[][][]): Doc => {
  const sections: Section[] = [];
  const sentences: Sentence[] = [];
  spec.forEach((paragraphs, i) => {
    const sectionId = `sec_${i}`;
    const ids: string[] = [];
    paragraphs.forEach((tokens, j) => {
      tokens.forEach((t, k) => {
        const id = `s_${i}_${j}_${k}`;
        ids.push(id);
        sentences.push({
          id,
          order: sentences.length,
          page: 0,
          pages: [0],
          sectionId,
          paragraphId: `p_${i}_${j}`,
          kind: 'sentence',
          enRaw: 'x'.repeat(t * 4),
          en: 'x'.repeat(t * 4),
          sourceSpans: [],
          rects: [],
          mappingStatus: 'mapped',
          equations: [],
          citationMarkers: [],
          warnings: [],
        });
      });
    });
    sections.push({ id: sectionId, title: `Section ${i}`, order: i, sentenceIds: ids });
  });
  return { sections, sentences };
};

const OPTS = { minTokens: 150, maxTokens: 250, neighborSentences: 2 };
const targets = (chunks: PlannedChunk[]): string[][] => chunks.map((c) => c.targetSentenceIds);

describe('planChunks', () => {
  it('작은 섹션은 이웃과 묶고, 하한을 채운 뒤 섹션이 바뀌면 닫는다', () => {
    const doc = makeDoc([[[40, 40]], [[50]], [[60]], [[100]], [[30]]]);
    const plan = planChunks(doc, OPTS);
    // 80 + 50 = 130(하한 미달) → 60을 더해 190 → 다음 섹션에서 닫음. 100 + 30 = 130.
    expect(targets(plan.chunks)).toEqual([
      ['s_0_0_0', 's_0_0_1', 's_1_0_0', 's_2_0_0'],
      ['s_3_0_0', 's_4_0_0'],
    ]);
    expect(plan.chunks[0]).toMatchObject({
      id: 'chunk_0001',
      order: 0,
      sectionId: 'sec_0',
      sectionIds: ['sec_0', 'sec_1', 'sec_2'],
      estimatedTokens: 190,
      warnings: [],
    });
    expect(plan.sentenceCount).toBe(6);
    expect(plan.estimatedTokens).toBe(320);
  });

  it('상한을 넘기 직전에 문단 경계에서 닫는다', () => {
    const doc = makeDoc([[[100], [100], [100]]]);
    expect(targets(planChunks(doc, OPTS).chunks)).toEqual([['s_0_0_0', 's_0_1_0'], ['s_0_2_0']]);
  });

  it('문단을 중간에서 자르지 않는다. 상한보다 큰 문단만 문장 경계에서 나눈다', () => {
    const kept = makeDoc([[[100], [60, 60, 60]]]);
    expect(targets(planChunks(kept, OPTS).chunks)).toEqual([
      ['s_0_0_0'],
      ['s_0_1_0', 's_0_1_1', 's_0_1_2'],
    ]);
    const split = makeDoc([[[100, 100, 100, 100]]]);
    expect(targets(planChunks(split, OPTS).chunks)).toEqual([
      ['s_0_0_0', 's_0_0_1'],
      ['s_0_0_2', 's_0_0_3'],
    ]);
  });

  it('문장 하나가 상한보다 크면 그 문장만으로 청크를 만들고 경고한다', () => {
    const doc = makeDoc([[[50], [400], [50]]]);
    const plan = planChunks(doc, OPTS);
    expect(targets(plan.chunks)).toEqual([['s_0_0_0'], ['s_0_1_0'], ['s_0_2_0']]);
    expect(plan.chunks[1]?.warnings).toHaveLength(1);
  });

  it('앞뒤 문맥은 대상 바로 앞 2문장과 바로 뒤 2문장이고 섹션 경계를 넘는다', () => {
    const doc = makeDoc([[[100, 100]], [[100, 100]], [[100, 100]]]);
    const plan = planChunks(doc, OPTS);
    expect(plan.chunks.map((c) => c.neighborSentenceIds)).toEqual([
      ['s_1_0_0', 's_1_0_1'],
      ['s_0_0_0', 's_0_0_1', 's_2_0_0', 's_2_0_1'],
      ['s_1_0_0', 's_1_0_1'],
    ]);
    const none = planChunks(doc, { ...OPTS, neighborSentences: 0 });
    expect(none.chunks.every((c) => c.neighborSentenceIds.length === 0)).toBe(true);
  });

  it('문장 없는 섹션은 건너뛰고, 빈 문서는 청크가 없다', () => {
    const doc = makeDoc([[], [[100]], []]);
    expect(planChunks(doc, OPTS).chunks.map((c) => c.sectionIds)).toEqual([['sec_1']]);
    expect(planChunks(makeDoc([]), OPTS).chunks).toEqual([]);
  });

  it('잘못된 크기 설정은 거절한다', () => {
    const doc = makeDoc([[[10]]]);
    expect(() => planChunks(doc, { minTokens: 300, maxTokens: 200 })).toThrow();
    expect(() => planChunks(doc, { neighborSentences: -1 })).toThrow();
  });

  it('속성: 청크 대상의 합집합은 본문 문장 전체이고 교집합이 없으며 순서가 유지된다', () => {
    const spec = fc.array(
      fc.array(fc.array(fc.integer({ min: 1, max: 400 }), { minLength: 1, maxLength: 6 }), {
        maxLength: 5,
      }),
      { maxLength: 12 },
    );
    fc.assert(
      fc.property(
        spec,
        fc.integer({ min: 0, max: 300 }),
        fc.integer({ min: 0, max: 300 }),
        fc.integer({ min: 0, max: 3 }),
        (s, min, extra, neighbors) => {
          const doc = makeDoc(s);
          const options = {
            minTokens: min,
            maxTokens: min + extra + 1,
            neighborSentences: neighbors,
          };
          const plan = planChunks(doc, options);
          const body = bodySentences(doc).map((b) => b.sentence.id);
          expect(plan.chunks.flatMap((c) => c.targetSentenceIds)).toEqual(body);
          expect(new Set(body).size).toBe(body.length);
          const tokenOf = new Map(doc.sentences.map((x) => [x.id, x.en.length / 4]));
          for (const chunk of plan.chunks) {
            expect(chunk.targetSentenceIds.length).toBeGreaterThan(0);
            const own = new Set(chunk.targetSentenceIds);
            for (const id of chunk.neighborSentenceIds) expect(own.has(id)).toBe(false);
            expect(chunk.neighborSentenceIds.length).toBeLessThanOrEqual(neighbors * 2);
            const total = chunk.targetSentenceIds.reduce((n, id) => n + (tokenOf.get(id) ?? 0), 0);
            expect(chunk.estimatedTokens).toBe(total);
            // 상한을 넘는 청크는 문장 하나짜리뿐이다.
            if (total > options.maxTokens) expect(chunk.targetSentenceIds).toHaveLength(1);
          }
          expect(new Set(plan.chunks.map((c) => c.id)).size).toBe(plan.chunks.length);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('chunkInputHash', () => {
  const doc = makeDoc([[[100, 100]], [[100, 100]]]);
  const byId = new Map(doc.sentences.map((s) => [s.id, s]));
  const chunk = planChunks(doc, OPTS).chunks[0];
  const versions = {
    promptVersion: 'translate.chunk@aaaaaaaaaaaa',
    contextVersion: 1,
    contextSha256: 'c'.repeat(64),
  };

  it('같은 입력이면 같고 64자리 16진수다', () => {
    if (!chunk) throw new Error('청크가 없습니다');
    const hash = chunkInputHash(chunk, byId, versions);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(chunkInputHash({ ...chunk }, new Map(byId), { ...versions })).toBe(hash);
  });

  it('문장 글, 문맥, 프롬프트·컨텍스트 버전 중 하나라도 바뀌면 달라진다', () => {
    if (!chunk) throw new Error('청크가 없습니다');
    const base = chunkInputHash(chunk, byId, versions);
    const edited = new Map(byId);
    const first = doc.sentences[0];
    if (first) edited.set(first.id, { ...first, en: `${first.en}.` });
    expect(chunkInputHash(chunk, edited, versions)).not.toBe(base);
    expect(chunkInputHash({ ...chunk, neighborSentenceIds: [] }, byId, versions)).not.toBe(base);
    expect(chunkInputHash(chunk, byId, { ...versions, promptVersion: 'x@1' })).not.toBe(base);
    expect(chunkInputHash(chunk, byId, { ...versions, contextVersion: 2 })).not.toBe(base);
    expect(chunkInputHash(chunk, byId, { ...versions, contextSha256: 'd'.repeat(64) })).not.toBe(
      base,
    );
  });

  it('문서에 없는 문장을 가리키면 던진다', () => {
    expect(() =>
      chunkInputHash({ targetSentenceIds: ['nope'], neighborSentenceIds: [] }, byId, versions),
    ).toThrow();
  });
});
