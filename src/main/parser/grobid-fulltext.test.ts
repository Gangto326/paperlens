import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE_SHA } from '@shared/schema/fixtures';
import { PaperCacheStore } from '../cache/paper-cache-store';
import { GrobidClient } from './grobid-client';
import { FULLTEXT_TEI_COORDINATES, processFulltext, saveOriginalTei } from './grobid-fulltext';

const TEI =
  '<?xml version="1.0" encoding="UTF-8"?>\n<TEI xmlns="http://www.tei-c.org/ns/1.0"><text><body><p><s coords="1,72.0,100.0,300.0,12.0">Hello.</s></p></body></text></TEI>';

let server: Server | null = null;
let received: { contentType: string; body: string; accept: string } | null = null;

async function listen(status = 200, body = TEI): Promise<string> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received = {
        contentType: req.headers['content-type'] ?? '',
        accept: req.headers['accept'] ?? '',
        body: Buffer.concat(chunks).toString('latin1'),
      };
      res.writeHead(status, { 'content-type': 'application/xml' }).end(body);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return `http://127.0.0.1:${addr.port}`;
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  received = null;
});

describe('processFulltext', () => {
  it('multipart로 input과 계획된 매개변수를 보내고 TEI를 받는다', async () => {
    const baseUrl = await listen();
    const client = new GrobidClient({ baseUrl, timeoutMs: 1000, retryDelayMs: 1 });
    const pdf = new TextEncoder().encode('%PDF-1.4 fake');
    const r = await processFulltext(client, pdf, 'x.pdf');
    expect(r.tei).toBe(TEI);
    expect(r.hasSentenceCoords).toBe(true);
    expect(r.parserConfigHash).toMatch(/^[0-9a-f]{16}$/);

    expect(received?.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(received?.accept).toBe('application/xml');
    const body = received?.body ?? '';
    expect(body).toContain('name="input"; filename="x.pdf"');
    expect(body).toContain('%PDF-1.4 fake');
    expect(body).toContain('name="segmentSentences"\r\n\r\n1');
    expect(body).toContain('name="consolidateHeader"\r\n\r\n0');
    expect(body).toContain('name="consolidateCitations"\r\n\r\n0');
    for (const c of FULLTEXT_TEI_COORDINATES) {
      expect(body).toContain(`name="teiCoordinates"\r\n\r\n${c}`);
    }
    expect(body.match(/name="teiCoordinates"/g)).toHaveLength(FULLTEXT_TEI_COORDINATES.length);
  });

  it('문장 좌표가 없으면 hasSentenceCoords=false', async () => {
    const baseUrl = await listen(200, '<TEI><text><body><p><s>Hi.</s></p></body></text></TEI>');
    const r = await processFulltext(new GrobidClient({ baseUrl }), new Uint8Array(4));
    expect(r.hasSentenceCoords).toBe(false);
  });

  it('TEI가 아닌 응답은 거부한다', async () => {
    const baseUrl = await listen(200, '<html>oops</html>');
    await expect(processFulltext(new GrobidClient({ baseUrl }), new Uint8Array(4))).rejects.toThrow(
      /TEI가 아닙니다/,
    );
  });

  it('GROBID 오류(500)는 GrobidError로 전달된다', async () => {
    const baseUrl = await listen(500, 'boom');
    await expect(
      processFulltext(new GrobidClient({ baseUrl }), new Uint8Array(4)),
    ).rejects.toMatchObject({
      name: 'GrobidError',
      kind: 'http',
    });
  });
});

describe('saveOriginalTei', () => {
  let root: string;
  let store: PaperCacheStore;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'paperlens-tei-'));
    store = new PaperCacheStore(root);
    await store.initPaper(SAMPLE_SHA);
  });
  afterEach(async () => fs.rm(root, { recursive: true, force: true }));

  it('original.tei.xml을 그대로 쓰고 manifest.files에 해시를 남긴다', async () => {
    const path = await saveOriginalTei(store, SAMPLE_SHA, 'rabc', TEI);
    expect(path).toBe(store.extractionPath(SAMPLE_SHA, 'rabc', 'original.tei.xml'));
    expect(await fs.readFile(path, 'utf8')).toBe(TEI);
    const m = await store.readManifest(SAMPLE_SHA);
    expect(m.files.map((f) => f.path)).toEqual(['extraction/rabc/original.tei.xml']);
    expect(await store.verifyFiles(SAMPLE_SHA)).toEqual([]);
  });
});
