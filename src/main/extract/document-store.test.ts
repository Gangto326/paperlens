import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaperCacheStore } from '../cache/paper-cache-store';
import { saveOriginalTei } from '../parser/grobid-fulltext';
import { TINY_SHA, TINY_TEI, tinyFonts, tinyItems, tinyPages } from './__fixtures__/tiny-paper';
import { buildAndSaveDocument, readSentenceIndex } from './document-store';
import { saveTextItems } from './text-items-store';

let root: string;
let store: PaperCacheStore;
const NOW = new Date('2026-09-26T10:00:00.000Z');
const OPTS = { parserConfigHash: 'cfg0', now: NOW };

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'paperlens-document-'));
  store = new PaperCacheStore(root);
  await store.initPaper(TINY_SHA, NOW);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function extract(): Promise<string> {
  const r = await saveTextItems(
    store,
    {
      pdfSha256: TINY_SHA,
      pdfjsVersion: '6.3.289',
      textExtractorVersion: '2',
      pages: tinyPages(),
      textItems: tinyItems(),
      fonts: tinyFonts(),
    },
    OPTS,
  );
  expect(r.halted).toBe(false);
  return r.extractionRevision;
}

const buildOpts = (pages = tinyPages()) => ({
  fileName: 'tiny.pdf',
  originalPath: '/x/tiny.pdf',
  pages,
  parserVersion: '0.9.1',
  parserConfigHash: 'cfg0',
  now: NOW,
});

describe('buildAndSaveDocument', () => {
  it('imported → extracting → mapping: document.json을 확정하고 manifest에 해시·상태를 기록한다', async () => {
    expect((await store.readManifest(TINY_SHA)).state).toBe('imported');
    const rev = await extract();
    expect((await store.readManifest(TINY_SHA)).state).toBe('extracting');
    await saveOriginalTei(store, TINY_SHA, rev, TINY_TEI);

    const result = await buildAndSaveDocument(store, TINY_SHA, buildOpts());
    expect(result.extractionRevision).toBe(rev);
    expect(result.documentPath).toBe(store.extractionPath(TINY_SHA, rev, 'document.json'));
    expect(result).toMatchObject({
      sentenceCount: 5,
      mapped: 4,
      uncertain: 0,
      unmapped: 1,
      equationCount: 1,
      readingOrderMismatches: 1,
    });

    const m = await store.readManifest(TINY_SHA);
    expect(m.state).toBe('mapping');
    expect(m.currentExtractionRevision).toBe(rev);
    expect(m.files.map((f) => f.path).sort()).toEqual([
      `extraction/${rev}/document.json`,
      `extraction/${rev}/original.tei.xml`,
      `extraction/${rev}/source-map.json`,
    ]);
    expect(await store.verifyFiles(TINY_SHA)).toEqual([]);
    const doc = await store.readJson('extractionDocument', result.documentPath);
    expect(doc.pipeline.extractionRevision).toBe(rev);
    expect(doc.sentences[2]?.en).toBe('We define [EQ_1] here.');
    expect(doc.warnings).toEqual(result.warnings);
  });

  it('재실행하면 같은 rev·같은 문장 ID·같은 문서가 나온다', async () => {
    const rev1 = await extract();
    await saveOriginalTei(store, TINY_SHA, rev1, TINY_TEI);
    const r1 = await buildAndSaveDocument(store, TINY_SHA, buildOpts());
    const doc1 = await store.readJson('extractionDocument', r1.documentPath);

    const rev2 = await extract();
    await saveOriginalTei(store, TINY_SHA, rev2, TINY_TEI);
    const r2 = await buildAndSaveDocument(store, TINY_SHA, buildOpts());
    const doc2 = await store.readJson('extractionDocument', r2.documentPath);

    expect(rev2).toBe(rev1);
    expect(doc2.sentences.map((s) => s.id)).toEqual(doc1.sentences.map((s) => s.id));
    expect(doc2).toEqual(doc1);
    expect((await store.readManifest(TINY_SHA)).files).toHaveLength(3);
  });

  it('TEI가 없거나 rev가 없으면 문서를 만들지 않는다', async () => {
    await expect(buildAndSaveDocument(store, TINY_SHA, buildOpts())).rejects.toThrow(
      /revision이 없습니다/,
    );
    const rev = await extract();
    await expect(buildAndSaveDocument(store, TINY_SHA, buildOpts())).rejects.toThrow(/missing/);
    expect(await store.exists(store.extractionPath(TINY_SHA, rev, 'document.json'))).toBe(false);
    expect((await store.readManifest(TINY_SHA)).state).toBe('extracting');
  });
});

describe('readSentenceIndex', () => {
  it('document.json이 없으면 missing 오류, 확정 뒤에는 order 순 문장 색인을 돌려준다', async () => {
    const rev = await extract();
    await expect(readSentenceIndex(store, TINY_SHA)).rejects.toMatchObject({ reason: 'missing' });
    await saveOriginalTei(store, TINY_SHA, rev, TINY_TEI);
    const saved = await buildAndSaveDocument(store, TINY_SHA, buildOpts());

    const index = await readSentenceIndex(store, TINY_SHA);
    expect(index.documentPath).toBe(saved.documentPath);
    expect(index.extractionRevision).toBe(rev);
    expect(index.pages.length).toBe(tinyPages().length);
    expect(index.sentences.map((s) => s.id)).toEqual(
      saved.build.document.sentences.map((s) => s.id),
    );
    expect(index.sentences.map((s) => s.order)).toEqual(
      [...index.sentences.map((s) => s.order)].sort((a, b) => a - b),
    );
    for (const s of index.sentences) {
      expect(s).not.toHaveProperty('enRaw');
      expect(s).not.toHaveProperty('citationMarkers');
      // 사각형은 document.json의 것을 그대로 준다(tiny fixture는 페이지 상자 밖 좌표라 GROBID 공간이 남는 것도 있다).
      expect(s.rects).toEqual(saved.build.document.sentences.find((d) => d.id === s.id)?.rects);
    }
    expect(index.excludedBlocks.length).toBe(saved.build.document.excludedBlocks.length);
  });

  it('document.json이 manifest 해시와 다르면 hash_mismatch', async () => {
    const rev = await extract();
    await saveOriginalTei(store, TINY_SHA, rev, TINY_TEI);
    const saved = await buildAndSaveDocument(store, TINY_SHA, buildOpts());
    await fs.appendFile(saved.documentPath, ' ');
    await expect(readSentenceIndex(store, TINY_SHA)).rejects.toMatchObject({
      reason: 'hash_mismatch',
    });
  });
});

describe('이미 처리한 논문을 다시 열 때의 상태', () => {
  const open = async (): Promise<void> => {
    const rev = await extract();
    await saveOriginalTei(store, TINY_SHA, rev, TINY_TEI);
    await buildAndSaveDocument(store, TINY_SHA, buildOpts());
  };
  const setState = async (
    state: 'translating' | 'complete' | 'paused' | 'failed',
  ): Promise<void> => {
    await store.updateManifest(TINY_SHA, (m) => {
      m.state = state;
      m.currentGenerationId = 'gen_1';
    });
  };

  it('같은 추출본이면 추출과 문장 연결을 다시 해도 더 나아간 상태를 되돌리지 않는다', async () => {
    await open();
    for (const state of ['translating', 'complete', 'paused'] as const) {
      await setState(state);
      await extract();
      expect((await store.readManifest(TINY_SHA)).state).toBe(state);
      await buildAndSaveDocument(store, TINY_SHA, buildOpts());
      const manifest = await store.readManifest(TINY_SHA);
      expect(manifest.state).toBe(state);
      expect(manifest.currentGenerationId).toBe('gen_1');
    }
  });

  it('mapping에서 다시 추출하면 mapping에 머문다', async () => {
    await open();
    await extract();
    expect((await store.readManifest(TINY_SHA)).state).toBe('mapping');
  });

  it('failed는 지키지 않는다. 다시 열면 처음 단계부터 간다', async () => {
    await open();
    await setState('failed');
    await extract();
    expect((await store.readManifest(TINY_SHA)).state).toBe('extracting');
  });

  it('추출 revision이 바뀌면 새 추출본이므로 extracting으로 간다', async () => {
    await open();
    await setState('complete');
    const r = await saveTextItems(
      store,
      {
        pdfSha256: TINY_SHA,
        pdfjsVersion: '6.3.289',
        textExtractorVersion: '3',
        pages: tinyPages(),
        textItems: tinyItems(),
        fonts: tinyFonts(),
      },
      OPTS,
    );
    const manifest = await store.readManifest(TINY_SHA);
    expect(manifest.currentExtractionRevision).toBe(r.extractionRevision);
    expect(manifest.state).toBe('extracting');
  });

  it('캐시의 document.json으로 색인을 읽으면 extracting에 머문 상태를 mapping으로 올린다', async () => {
    await open();
    await store.updateManifest(TINY_SHA, (m) => {
      m.state = 'extracting';
    });
    await readSentenceIndex(store, TINY_SHA);
    expect((await store.readManifest(TINY_SHA)).state).toBe('mapping');
    await setState('complete');
    await readSentenceIndex(store, TINY_SHA);
    expect((await store.readManifest(TINY_SHA)).state).toBe('complete');
  });
});
