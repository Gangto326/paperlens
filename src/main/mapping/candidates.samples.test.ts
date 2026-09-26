import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { textItemToUserRect, type PageBox } from '@shared/geometry/coords';
import {
  DEFAULT_RECT_MARGIN_PT,
  TextItemIndex,
  candidateStats,
  findCandidates,
  type SentenceCandidates,
} from '@shared/mapping/candidates';
import type { Sentence, TextItemRecord } from '@shared/schema/types';
import { normalizeTei } from '../parser/tei-normalize';

/**
 * 실샘플(fixtures/papers/*.pdf + fixtures/tei/*.tei.xml, 둘 다 gitignore, 없으면 skip)에서
 * GROBID 문장 사각형 → PDF.js 텍스트 항목 후보 검색의 분포를 확인한다.
 * - 텍스트 항목은 renderer collectTextItems와 같은 규칙(str 보유 항목만, `t_<page>_<index>`)으로 pdfjs-dist legacy에서 모은다.
 * - 단어 적중률: 문장의 4글자 이상 영단어가 후보 항목 문자열 연결에 들어 있는 비율(C1.10 실측과 같은 지표).
 * PAPERLENS_REPORT=1 이면 여유(pt)별 분포를 표준 출력에 찍는다(커밋 본문 수치의 출처).
 */
const IDS = ['2005.11401', '2312.06718', '2410.21418'];
const papers = resolve(__dirname, '../../../fixtures/papers');
const teis = resolve(__dirname, '../../../fixtures/tei');
const available = IDS.filter(
  (id) => existsSync(resolve(papers, `${id}.pdf`)) && existsSync(resolve(teis, `${id}.tei.xml`)),
);
const report = process.env['PAPERLENS_REPORT'] === '1';

interface Loaded {
  items: TextItemRecord[];
  boxes: PageBox[];
  sentences: Sentence[];
}

async function load(id: string): Promise<Loaded> {
  const data = new Uint8Array(readFileSync(resolve(papers, `${id}.pdf`)));
  const task = getDocument({ data, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const items: TextItemRecord[] = [];
  const boxes: PageBox[] = [];
  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1);
    boxes.push({
      viewBox: page.view as [number, number, number, number],
      rotation: page.rotate,
      userUnit: page.userUnit,
    });
    const content = await page.getTextContent();
    let index = 0;
    for (const item of content.items) {
      if (!('str' in item)) continue;
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
  return { items, boxes, sentences };
}

function wordHit(
  sentences: readonly Sentence[],
  results: readonly SentenceCandidates[],
  byId: Map<string, TextItemRecord>,
): { hit: number; total: number } {
  let hit = 0;
  let total = 0;
  results.forEach((r, i) => {
    const words = sentences[i]!.enRaw.split(/\s+/).filter((w) => /^[A-Za-z]{4,}$/.test(w));
    if (words.length === 0) return;
    const blob = r.textItemIds.map((id) => byId.get(id)!.str).join(' ');
    total += words.length;
    for (const w of words) if (blob.includes(w)) hit++;
  });
  return { hit, total };
}

/** C1.10 실측 방식(항목 중심점이 ±margin 안) — 사각형 겹침과의 비교용. */
function centerPointCandidates(
  sentences: readonly Sentence[],
  loaded: Loaded,
  margin: number,
): SentenceCandidates[] {
  const byPage = new Map<number, { item: TextItemRecord; cx: number; cy: number }[]>();
  for (const item of loaded.items) {
    const r = textItemToUserRect(item);
    const list = byPage.get(item.pageIndex) ?? [];
    list.push({ item, cx: r.x + r.width / 2, cy: r.y + r.height / 2 });
    byPage.set(item.pageIndex, list);
  }
  return sentences.map((s) => {
    const ids = new Set<string>();
    for (const rect of s.rects) {
      const box = loaded.boxes[rect.pageIndex];
      if (!box) continue;
      const h = box.viewBox[3] - box.viewBox[1];
      const x0 = rect.x - margin;
      const x1 = rect.x + rect.width + margin;
      const y0 = h - rect.y - rect.height - margin;
      const y1 = h - rect.y + margin;
      for (const { item, cx, cy } of byPage.get(rect.pageIndex) ?? []) {
        if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) ids.add(item.id);
      }
    }
    return { sentenceId: s.id, textItemIds: [...ids], perRect: [], reasons: [] };
  });
}

describe.skipIf(available.length === 0)('문장 사각형 → 텍스트 항목 후보 (실샘플)', () => {
  it.each(available)(
    '%s: 좌표 있는 문장은 거의 모두 후보를 갖고, 단어 적중률이 중심점 방식 이상이다',
    async (id) => {
      const loaded = await load(id);
      const { items, boxes, sentences } = loaded;
      const byId = new Map(items.map((i) => [i.id, i]));
      const index = new TextItemIndex(items);
      const pageBoxOf = (i: number) => boxes[i];

      if (report) {
        for (const margin of [0, 1, 2, 3, 5]) {
          const results = sentences.map((s) =>
            findCandidates(s, index, pageBoxOf, { marginPt: margin }),
          );
          const st = candidateStats(results);
          const wh = wordHit(sentences, results, byId);
          const cp = wordHit(sentences, centerPointCandidates(sentences, loaded, margin), byId);
          const cpZero = centerPointCandidates(sentences, loaded, margin).filter(
            (r) => r.textItemIds.length === 0,
          ).length;
          console.log(
            `[report] ${id} margin=${margin}pt sentences=${st.sentences} zero=${st.zero} ${JSON.stringify(st.zeroByReason)} ` +
              `cand min/med/mean/max=${st.min}/${st.median}/${st.mean.toFixed(1)}/${st.max} ` +
              `wordHit=${((100 * wh.hit) / wh.total).toFixed(1)}% (${wh.hit}/${wh.total}) | ` +
              `centerPoint wordHit=${((100 * cp.hit) / cp.total).toFixed(1)}% zero=${cpZero}`,
          );
        }
      }

      const results = sentences.map((s) => findCandidates(s, index, pageBoxOf));
      const stats = candidateStats(results);
      if (report) {
        // 적중하지 못한 단어 표본(C1.12 문자열 정렬이 다뤄야 할 차이의 출처)
        const misses: string[] = [];
        results.forEach((r, i) => {
          if (misses.length >= 12) return;
          const blob = r.textItemIds.map((tid) => byId.get(tid)!.str).join(' ');
          for (const w of sentences[i]!.enRaw.split(/\s+/)) {
            if (/^[A-Za-z]{4,}$/.test(w) && !blob.includes(w))
              misses.push(`${w} ⇐ "${blob.slice(0, 60)}"`);
          }
        });
        console.log(`[report] ${id} misses (${misses.length} shown):\n  ${misses.join('\n  ')}`);
      }
      const withRects = sentences.filter((s) => s.rects.length > 0).length;
      const zeroWithRects = results.filter(
        (r, i) => r.textItemIds.length === 0 && sentences[i]!.rects.length > 0,
      ).length;
      const wh = wordHit(sentences, results, byId);
      const cp = wordHit(
        sentences,
        centerPointCandidates(sentences, loaded, DEFAULT_RECT_MARGIN_PT),
        byId,
      );

      expect(stats.sentences).toBe(sentences.length);
      // 좌표가 있는데 후보 0건인 문장은 1% 미만
      expect(zeroWithRects / withRects).toBeLessThan(0.01);
      // 후보 목록은 페이지·index 오름차순, 중복 없음
      for (const r of results) {
        const seq = r.textItemIds.map((tid) => {
          const it = byId.get(tid)!;
          return it.pageIndex * 1e6 + it.index;
        });
        expect(seq).toEqual([...new Set(seq)].sort((a, b) => a - b));
      }
      // 사각형 겹침은 중심점 판정보다 단어를 더(또는 같게) 회수한다
      expect(wh.hit / wh.total).toBeGreaterThanOrEqual(cp.hit / cp.total);
      expect(wh.hit / wh.total).toBeGreaterThan(0.95);
    },
    60_000,
  );
});
