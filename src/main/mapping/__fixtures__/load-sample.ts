import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PageBox } from '@shared/geometry/coords';
import type { Sentence, TextItemRecord } from '@shared/schema/types';
import { normalizeTei } from '../../parser/tei-normalize';

/**
 * 실샘플 로더(테스트 전용). fixtures/papers/*.pdf + fixtures/tei/*.tei.xml(둘 다 gitignore)에서
 * - 텍스트 항목은 renderer collectTextItems와 같은 규칙(str 보유 항목만, `t_<page>_<index>`)으로 pdfjs-dist legacy에서 모으고
 * - 문장은 normalizeTei로 만든다.
 * 둘 중 하나라도 없는 샘플은 `available`에서 빠지므로 테스트는 describe.skipIf(available.length === 0)로 건너뛴다.
 */
export const SAMPLE_IDS = ['2005.11401', '2312.06718', '2410.21418'];
const papers = resolve(__dirname, '../../../../fixtures/papers');
const teis = resolve(__dirname, '../../../../fixtures/tei');
export const available = SAMPLE_IDS.filter(
  (id) => existsSync(resolve(papers, `${id}.pdf`)) && existsSync(resolve(teis, `${id}.tei.xml`)),
);
export const report = process.env['PAPERLENS_REPORT'] === '1';

export interface Loaded {
  items: TextItemRecord[];
  boxes: PageBox[];
  sentences: Sentence[];
  /** 항목 fontName(내부 이름) → 실제 글꼴 이름. opts.fonts일 때만 채운다(getOperatorList 비용: 52쪽 약 8초). */
  fonts: Map<string, string>;
}

function fontBaseName(
  page: { commonObjs: { has(id: string): boolean; get(id: string): unknown } },
  fontName: string,
): string {
  if (!page.commonObjs.has(fontName)) return '';
  const font = page.commonObjs.get(fontName);
  if (typeof font !== 'object' || font === null) return '';
  const name = (font as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

export async function loadSample(id: string, opts: { fonts?: boolean } = {}): Promise<Loaded> {
  const data = new Uint8Array(readFileSync(resolve(papers, `${id}.pdf`)));
  const task = getDocument({ data, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const items: TextItemRecord[] = [];
  const boxes: PageBox[] = [];
  const fonts = new Map<string, string>();
  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1);
    if (opts.fonts) await page.getOperatorList();
    boxes.push({
      viewBox: page.view as [number, number, number, number],
      rotation: page.rotate,
      userUnit: page.userUnit,
    });
    const content = await page.getTextContent();
    let index = 0;
    for (const item of content.items) {
      if (!('str' in item)) continue;
      if (opts.fonts && !fonts.has(item.fontName))
        fonts.set(item.fontName, fontBaseName(page, item.fontName));
      items.push({
        id: `t_${i}_${index}`,
        pageIndex: i,
        index,
        str: item.str,
        transform: item.transform as [number, number, number, number, number, number],
        width: item.width,
        height: item.height,
        fontName: item.fontName,
        dir: item.dir,
        hasEOL: item.hasEOL,
      });
      index++;
    }
  }
  await task.destroy();
  const tei = readFileSync(resolve(teis, `${id}.tei.xml`), 'utf8');
  const { sentences } = normalizeTei(tei, { pdfSha256: 'a'.repeat(64), extractionRevision: 'r' });
  return { items, boxes, sentences, fonts };
}
