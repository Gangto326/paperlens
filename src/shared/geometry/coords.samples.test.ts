import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';

/**
 * 실샘플(fixtures/papers/*.pdf + fixtures/tei/*.tei.xml, 둘 다 gitignore)에서
 * GROBID(pdfalto) facsimile surface 크기와 PDF.js page.view 크기를 페이지마다 대조한다.
 * 파일이 없으면 skip.
 */
const IDS = ['2005.11401', '2312.06718', '2410.21418'];
const papers = resolve(__dirname, '../../../fixtures/papers');
const teis = resolve(__dirname, '../../../fixtures/tei');
const available = IDS.filter(
  (id) => existsSync(resolve(papers, `${id}.pdf`)) && existsSync(resolve(teis, `${id}.tei.xml`)),
);

describe.skipIf(available.length === 0)('GROBID surface ↔ PDF.js view', () => {
  it.each(available)(
    '%s: 모든 페이지의 surface 크기 = view 크기, 회전 0, userUnit 1',
    async (id) => {
      const tei = readFileSync(resolve(teis, `${id}.tei.xml`), 'utf8');
      const surfaces = [
        ...tei.matchAll(
          /<surface n="(\d+)" ulx="([\d.]+)" uly="([\d.]+)" lrx="([\d.]+)" lry="([\d.]+)"/g,
        ),
      ].map((m) => m.slice(1).map(Number) as [number, number, number, number, number]);
      const data = new Uint8Array(readFileSync(resolve(papers, `${id}.pdf`)));
      const task = getDocument({
        data,
        useSystemFonts: false,
        verbosity: 0,
      });
      const doc = await task.promise;
      expect(surfaces).toHaveLength(doc.numPages);
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const [n, ulx, uly, lrx, lry] = surfaces[i - 1]!;
        const [x1, y1, x2, y2] = page.view as [number, number, number, number];
        expect(n).toBe(i);
        expect(page.rotate).toBe(0);
        expect(page.userUnit).toBe(1);
        expect(lrx - ulx).toBeCloseTo(x2 - x1, 2);
        expect(lry - uly).toBeCloseTo(y2 - y1, 2);
      }
      await task.destroy();
    },
  );
});
