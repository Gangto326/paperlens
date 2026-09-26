import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaperCacheStore } from '../cache/paper-cache-store';
import { saveOriginalTei } from '../parser/grobid-fulltext';
import { TINY_SHA, TINY_TEI, tinyFonts, tinyItems, tinyPages } from './__fixtures__/tiny-paper';
import { buildAndSaveDocument } from './document-store';
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
