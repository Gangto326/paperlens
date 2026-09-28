import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChunkDocument, ExtractionDocument, Section, Sentence } from '@shared/schema';
import { sampleChunk, sampleContext, sampleExtraction } from '@shared/schema/fixtures';
import { PaperCacheStore } from '../cache/paper-cache-store';
import { readTranslations } from './results-store';

const SHA = '9'.repeat(64);
const REV = 'rtest';
const GEN = 'gen_1';
const CHUNKER = { minTokens: 150, maxTokens: 250, neighborSentences: 1 };

const makeDocument = (): ExtractionDocument => {
  const sections: Section[] = [];
  const sentences: Sentence[] = [];
  for (let i = 0; i < 3; i += 1) {
    const ids = [`id_${i}_0`, `id_${i}_1`];
    ids.forEach((id) => {
      const en = 'x'.repeat(400);
      sentences.push({
        id,
        order: sentences.length,
        page: 0,
        pages: [0],
        sectionId: `sec_${i}`,
        paragraphId: `p_${i}`,
        kind: 'sentence',
        enRaw: en,
        en,
        sourceSpans: [],
        rects: [],
        mappingStatus: 'mapped',
        equations: [],
        citationMarkers: [],
        warnings: [],
      });
    });
    sections.push({ id: `sec_${i}`, title: `S${i}`, order: i, sentenceIds: ids });
  }
  return { ...sampleExtraction, sections, sentences };
};

let root: string;
let store: PaperCacheStore;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'paperlens-results-'));
  store = new PaperCacheStore(root);
  await store.initPaper(SHA);
  const path = store.extractionPath(SHA, REV, 'document.json');
  const sha = await store.writeJson('extractionDocument', path, makeDocument());
  await store.updateManifest(SHA, (m) => {
    store.recordFile(m, SHA, path, sha);
    m.currentExtractionRevision = REV;
    m.state = 'mapping';
  });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const saveChunk = async (
  index: number,
  status: ChunkDocument['status'],
  over: Partial<ChunkDocument> = {},
  record = true,
): Promise<string> => {
  const ids = [`id_${index}_0`, `id_${index}_1`];
  const id = `chunk_000${index + 1}`;
  const doc: ChunkDocument = {
    ...sampleChunk,
    id,
    sectionId: `sec_${index}`,
    targetSentenceIds: ids,
    status,
    attempts: 1,
    results: ids.map((s) => ({
      id: s,
      ko: `번역 ${s}`,
      note: '',
      refs: [],
      conceptIds: [],
      warnings: [],
    })),
    ...over,
  };
  const path = store.generationPath(SHA, GEN, `chunks/${id}.json`);
  const sha = await store.writeJson('chunkDocument', path, doc);
  await store.updateManifest(SHA, (m) => {
    if (record) store.recordFile(m, SHA, path, sha);
    m.currentGenerationId = GEN;
    m.state = 'translating';
  });
  return path;
};

describe('readTranslations', () => {
  it('세대가 없으면 청크 계획만 있고 모두 pending이다', async () => {
    const snapshot = await readTranslations(store, SHA, CHUNKER);
    expect(snapshot).toMatchObject({ state: 'mapping', generationId: null, results: {} });
    expect(snapshot.chunks).toEqual([
      { id: 'chunk_0001', status: 'pending', sentenceIds: ['id_0_0', 'id_0_1'] },
      { id: 'chunk_0002', status: 'pending', sentenceIds: ['id_1_0', 'id_1_1'] },
      { id: 'chunk_0003', status: 'pending', sentenceIds: ['id_2_0', 'id_2_1'] },
    ]);
  });

  it('완료 청크의 결과만 돌려준다. 실패한 청크의 부분 결과는 보여주지 않는다', async () => {
    await saveChunk(0, 'complete');
    await saveChunk(1, 'failed');
    const snapshot = await readTranslations(store, SHA, CHUNKER);
    expect(snapshot.chunks.map((c) => c.status)).toEqual(['complete', 'failed', 'pending']);
    expect(Object.keys(snapshot.results)).toEqual(['id_0_0', 'id_0_1']);
    expect(snapshot.results['id_0_0']).toEqual({
      ko: '번역 id_0_0',
      note: '',
      explanation: null,
      conceptIds: [],
      warnings: [],
      chunkId: 'chunk_0001',
    });
    expect(snapshot.concepts).toEqual({});
  });

  it('해설 칸과 개념 카드를 함께 돌려준다. 카드에 없는 개념 id는 뺀다', async () => {
    const contextPath = store.generationPath(SHA, GEN, 'context.json');
    const contextSha = await store.writeJson('contextDocument', contextPath, {
      ...sampleContext,
      concepts: [
        {
          id: 'c_1',
          name: 'fine-tuning',
          nameKo: '파인튜닝',
          definitionKo: '뜻',
          whyItMatters: '이유',
          exampleKo: null,
          prerequisiteConceptIds: [],
          refs: [],
          researchStatus: 'unresolved',
          contextVersion: 1,
        },
      ],
    });
    await store.updateManifest(SHA, (m) => {
      store.recordFile(m, SHA, contextPath, contextSha);
    });
    const explanation = { plain: '쉬운 뜻', role: '역할', example: '', deeper: '' };
    await saveChunk(0, 'complete', {
      results: ['id_0_0', 'id_0_1'].map((id) => ({
        id,
        ko: `번역 ${id}`,
        note: '',
        explanation,
        refs: [],
        conceptIds: ['c_1', 'c_404'],
        warnings: [],
      })),
    });
    const snapshot = await readTranslations(store, SHA, CHUNKER);
    expect(snapshot.results['id_0_0']).toMatchObject({ explanation, conceptIds: ['c_1'] });
    expect(snapshot.concepts).toEqual({
      c_1: {
        id: 'c_1',
        name: 'fine-tuning',
        nameKo: '파인튜닝',
        definitionKo: '뜻',
        whyItMatters: '이유',
        exampleKo: null,
        prerequisiteConceptIds: [],
        sourced: false,
        sources: [],
        further: [],
      },
    });
  });

  it('개념 카드의 자료 링크를 research.json에서 찾아 읽은 자료와 더 볼 자료로 나눈다', async () => {
    const source = (id: string, url: string, fetchStatus: 'read' | 'not_read') => ({
      id,
      discoveredUrl: url,
      finalUrl: url,
      title: `제목 ${id}`,
      publisher: 'read.example',
      sourceType: id === 'src_2' ? 'video' : 'article',
      discoveredBy: 'search' as const,
      discoveredAt: '2026-09-28T00:00:00.000Z',
      fetchStatus,
      evidenceIds: [],
      language: 'ko',
      jobId: 'rs_1',
    });
    const researchPath = store.generationPath(SHA, GEN, 'research.json');
    const researchSha = await store.writeJson('researchDocument', researchPath, {
      schemaVersion: 1,
      sources: [
        source('src_1', 'https://read.example/a', 'read'),
        source('src_2', 'https://video.example/b', 'not_read'),
        source('src_3', 'file:///etc/passwd', 'read'),
      ],
      evidence: [],
    });
    const ref = (sourceId: string) => ({ sourceId, evidenceIds: [], supports: '뜻' });
    const contextPath = store.generationPath(SHA, GEN, 'context.json');
    const contextSha = await store.writeJson('contextDocument', contextPath, {
      ...sampleContext,
      concepts: [
        {
          id: 'c_1',
          name: 'BM25',
          nameKo: null,
          definitionKo: '뜻',
          whyItMatters: '',
          exampleKo: null,
          prerequisiteConceptIds: [],
          refs: [ref('src_1'), ref('src_3'), ref('src_404'), ref('src_2')],
          furtherRefs: [ref('src_2')],
          researchStatus: 'researched',
          contextVersion: 1,
        },
      ],
    });
    await store.updateManifest(SHA, (m) => {
      store.recordFile(m, SHA, researchPath, researchSha);
      store.recordFile(m, SHA, contextPath, contextSha);
      m.currentGenerationId = GEN;
    });
    const snapshot = await readTranslations(store, SHA, CHUNKER);
    expect(snapshot.concepts?.['c_1']).toMatchObject({
      sourced: true,
      // 읽지 않은 자료, 없는 출처, http(s)가 아닌 주소는 읽은 자료에 들지 않는다.
      sources: [
        {
          sourceId: 'src_1',
          url: 'https://read.example/a',
          title: '제목 src_1',
          publisher: 'read.example',
          kind: 'article',
          language: 'ko',
          supports: '뜻',
        },
      ],
      further: [{ sourceId: 'src_2', url: 'https://video.example/b', kind: 'video' }],
    });
  });

  it('manifest에 없는 파일, 해시가 다른 파일, 대상이 다른 청크는 쓰지 않는다', async () => {
    await saveChunk(0, 'complete', {}, false);
    const tampered = await saveChunk(1, 'complete');
    await fs.writeFile(
      tampered,
      (await fs.readFile(tampered, 'utf8')).replace('번역 id_1_0', '바뀐 글'),
    );
    await saveChunk(2, 'complete', { targetSentenceIds: ['id_2_0'] });
    const snapshot = await readTranslations(store, SHA, CHUNKER);
    expect(snapshot.chunks.map((c) => c.status)).toEqual(['pending', 'pending', 'pending']);
    expect(snapshot.results).toEqual({});
  });

  it('document.json이 없으면 빈 결과다', async () => {
    await store.updateManifest(SHA, (m) => {
      m.currentExtractionRevision = 'rmissing';
    });
    expect(await readTranslations(store, SHA, CHUNKER)).toMatchObject({ chunks: [], results: {} });
  });
});
