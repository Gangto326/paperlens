import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TextExtractionPayload } from '@shared/ipc';
import type { Page, TextItemRecord } from '@shared/schema';
import { NORMALIZER_VERSION, normalizeText } from '@shared/normalize/normalizer';
import { SAMPLE_SHA } from '@shared/schema/fixtures';
import { PaperCacheStore } from '../cache/paper-cache-store';
import { computeExtractionRevision } from './revision';
import { parseTextExtractionPayload, saveTextItems } from './text-items-store';

let root: string;
let store: PaperCacheStore;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'paperlens-extract-'));
  store = new PaperCacheStore(root);
  await store.initPaper(SAMPLE_SHA);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function page(i: number): Page {
  return {
    pageIndex: i,
    pdfPageNumber: i + 1,
    width: 612,
    height: 792,
    rotation: 0,
    userUnit: 1,
    mediaBox: [0, 0, 612, 792],
    cropBox: [0, 0, 612, 792],
    coordinateSpace: 'pdf_user_space',
    textQuality: 'ok',
    warnings: [],
  };
}

function item(pageIndex: number, index: number, str: string): TextItemRecord {
  return {
    id: `t_${pageIndex}_${index}`,
    pageIndex,
    index,
    str,
    transform: [10, 0, 0, 10, 72, 700 - index * 12],
    width: str.length * 5,
    height: 10,
    fontName: 'g_d0_f1',
    dir: 'ltr',
    hasEOL: true,
  };
}

const SENTENCE = 'Large pre-trained language models store factual knowledge in their parameters.';

function textPayload(): TextExtractionPayload {
  const items: TextItemRecord[] = [];
  for (let p = 0; p < 2; p++) for (let i = 0; i < 5; i++) items.push(item(p, i, SENTENCE));
  return {
    pdfSha256: SAMPLE_SHA,
    pdfjsVersion: '6.3.289',
    textExtractorVersion: '1',
    fonts: [{ id: 'g_d0_f1', name: 'ABCDEF+CMR10', family: 'serif' }],
    pages: [page(0), page(1)],
    textItems: items,
  };
}

describe('saveTextItems', () => {
  it('텍스트 PDF: source-map.json 저장, manifest는 extracting + rev + 파일 해시', async () => {
    const payload = textPayload();
    const items = payload.textItems;
    const r = await saveTextItems(store, payload);
    expect(r.halted).toBe(false);
    expect(r.textQuality).toBe('ok');
    expect(r.itemCount).toBe(10);
    expect(r.pages.map((p) => p.textQuality)).toEqual(['ok', 'ok']);

    const doc = await store.readJson('sourceMapDocument', r.sourceMapPath);
    expect(doc.extractionRevision).toBe(r.extractionRevision);
    expect(doc.textItems).toHaveLength(10);
    expect(doc.fonts).toEqual(payload.fonts);
    expect(doc.normalizationMaps.map((m) => m.id)).toEqual(items.map((i) => `nm_${i.id}`));
    expect(doc.normalizationMaps.every((m) => m.version === NORMALIZER_VERSION)).toBe(true);
    expect(doc.normalizationMaps[0]?.segments).toEqual(normalizeText(items[0]!.str).segments);

    const m = await store.readManifest(SAMPLE_SHA);
    expect(m.state).toBe('extracting');
    expect(m.currentExtractionRevision).toBe(r.extractionRevision);
    expect(m.files.map((f) => f.path)).toEqual([
      `extraction/${r.extractionRevision}/source-map.json`,
    ]);
    expect(await store.verifyFiles(SAMPLE_SHA)).toEqual([]);
  });

  it('스캔 PDF(항목 없음): needs_ocr로 중단하고 manifest는 failed + errors', async () => {
    const r = await saveTextItems(store, { ...textPayload(), textItems: [] });
    expect(r.halted).toBe(true);
    expect(r.textQuality).toBe('needs_ocr');
    const m = await store.readManifest(SAMPLE_SHA);
    expect(m.state).toBe('failed');
    expect(m.currentExtractionRevision).toBeNull();
    expect(m.errors).toHaveLength(1);
    expect(m.errors[0]).toMatchObject({ stage: 'extract', code: 'needs_ocr', retryable: false });
  });

  it('깨진 글꼴(사설 영역): garbled로 중단', async () => {
    const pua = ''.repeat(40);
    const payload = textPayload();
    payload.textItems = payload.textItems.map((t) => ({ ...t, str: pua }));
    const r = await saveTextItems(store, payload);
    expect(r.textQuality).toBe('garbled');
    expect(r.halted).toBe(true);
    const m = await store.readManifest(SAMPLE_SHA);
    expect(m.errors[0]?.code).toBe('text_garbled');
  });

  it('같은 입력을 다시 저장해도 rev·errors가 늘지 않는다', async () => {
    const r1 = await saveTextItems(store, textPayload());
    const r2 = await saveTextItems(store, textPayload());
    expect(r2.extractionRevision).toBe(r1.extractionRevision);
    expect((await store.readManifest(SAMPLE_SHA)).files).toHaveLength(1);
    await saveTextItems(store, { ...textPayload(), textItems: [] });
    await saveTextItems(store, { ...textPayload(), textItems: [] });
    expect((await store.readManifest(SAMPLE_SHA)).errors).toHaveLength(1);
  });

  it('ID 규칙에 어긋나는 항목은 저장하지 않는다', async () => {
    const payload = textPayload();
    payload.textItems[0]!.id = 't_0_99';
    await expect(saveTextItems(store, payload)).rejects.toThrow(/≠/);
    const bad = textPayload();
    bad.textItems.push(item(5, 0, SENTENCE));
    await expect(saveTextItems(store, bad)).rejects.toThrow(/범위 밖/);
    expect(await store.exists(store.extractionPath(SAMPLE_SHA, 'x', 'source-map.json'))).toBe(
      false,
    );
  });

  it('스키마에 맞지 않는 항목(필드 누락)은 쓰기 단계에서 거부된다', async () => {
    const payload = textPayload();
    delete (payload.textItems[0] as Partial<TextItemRecord>).fontName;
    await expect(saveTextItems(store, payload)).rejects.toThrow(/sourceMapDocument/);
  });
});

describe('computeExtractionRevision', () => {
  it('같은 입력이면 같은 rev, 버전이 다르면 다른 rev', () => {
    const base = { pdfjsVersion: '6.3.289', textExtractorVersion: '1', normalizerVersion: '1' };
    const a = computeExtractionRevision(base);
    const b = computeExtractionRevision({ ...base, pdfjsVersion: '6.3.289' });
    const c = computeExtractionRevision({ ...base, pdfjsVersion: '6.3.290' });
    const d = computeExtractionRevision({ ...base, normalizerVersion: '2' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a).toMatch(/^r[0-9a-f]{12}$/);
  });
});

describe('parseTextExtractionPayload', () => {
  it('겉모양이 어긋나면 거부한다', () => {
    expect(() => parseTextExtractionPayload(null)).toThrow();
    expect(() => parseTextExtractionPayload({ ...textPayload(), pdfSha256: 'zz' })).toThrow(
      /sha256/,
    );
    expect(() => parseTextExtractionPayload({ ...textPayload(), pages: 'x' })).toThrow(/arrays/);
    expect(parseTextExtractionPayload(textPayload()).textItems).toHaveLength(10);
  });
});
