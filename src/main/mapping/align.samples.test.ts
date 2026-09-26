import { describe, expect, it } from 'vitest';
import { SentenceAligner, alignmentStats, type SentenceAlignment } from '@shared/mapping/align';
import { TextItemIndex, findCandidates } from '@shared/mapping/candidates';
import { normalizeText } from '@shared/normalize/normalizer';
import type { Sentence, TextItemRecord } from '@shared/schema/types';
import { available, loadSample, report } from './__fixtures__/load-sample';

/**
 * 실샘플(없으면 skip)에서 후보 내 문자열 정렬 → SourceSpan의 분포를 확인한다.
 * 정답 표본 fixture(C1.21)가 아직 없으므로 status 분포·편집 거리 비율·스팬 재구성 일치율로 대신한다.
 * PAPERLENS_REPORT=1 이면 분포와 uncertain/unmapped 표본을 표준 출력에 찍는다(커밋 본문 수치의 출처).
 */

/** 스팬의 원문 조각을 조립 규칙(hasEOL·페이지 경계 → 줄바꿈, index 건너뜀 → 공백)대로 이어 붙인다. */
function reconstruct(r: SentenceAlignment, byId: Map<string, TextItemRecord>): string {
  let raw = '';
  let prev: TextItemRecord | undefined;
  for (const sp of r.sourceSpans) {
    const item = byId.get(sp.textItemId)!;
    if (prev) {
      if (prev.hasEOL || prev.pageIndex !== item.pageIndex) raw += '\n';
      else if (item.index !== prev.index + 1) raw += ' ';
    }
    raw += item.str.slice(sp.utf16Start, sp.utf16End);
    prev = item;
  }
  return normalizeText(raw).text.trim();
}

/** 같은 페이지 사각형들의 x 차이가 페이지 폭의 1/3을 넘으면 열 경계를 넘는 문장으로 본다. */
function crossesColumn(s: Sentence, pageWidth: (i: number) => number): boolean {
  const byPage = new Map<number, number[]>();
  for (const r of s.rects) byPage.set(r.pageIndex, [...(byPage.get(r.pageIndex) ?? []), r.x]);
  for (const [p, xs] of byPage) {
    if (Math.max(...xs) - Math.min(...xs) > pageWidth(p) / 3) return true;
  }
  return false;
}

describe.skipIf(available.length === 0)('후보 내 문자열 정렬 → SourceSpan (실샘플)', () => {
  it.each(available)(
    '%s: 대부분 mapped, 스팬은 후보 항목 범위 안, 정확 일치 문장은 스팬에서 원문이 복원된다',
    async (id) => {
      const { items, boxes, sentences } = await loadSample(id);
      const byId = new Map(items.map((i) => [i.id, i]));
      const index = new TextItemIndex(items);
      const pageBoxOf = (i: number) => boxes[i];
      const candidates = sentences.map((s) => findCandidates(s, index, pageBoxOf));
      const aligner = new SentenceAligner(items);
      const t0 = performance.now();
      const results = sentences.map((s, i) => aligner.align(s, candidates[i]!));
      const ms = performance.now() - t0;
      const st = alignmentStats(results);

      const pageWidth = (i: number) => boxes[i]!.viewBox[2] - boxes[i]!.viewBox[0];
      const multiPage = sentences.filter((s) => s.pages.length > 1);
      const multiCol = sentences.filter((s) => crossesColumn(s, pageWidth));
      const statusOf = (list: Sentence[]) => {
        const c = { mapped: 0, uncertain: 0, unmapped: 0 };
        for (const s of list) c[results[s.order]!.status]++;
        return c;
      };
      let exactMismatch = 0;
      results.forEach((r, i) => {
        if (r.exact && reconstruct(r, byId) !== normalizeText(sentences[i]!.en).text.trim())
          exactMismatch++;
      });

      if (report) {
        const pct = (n: number) => ((100 * n) / st.sentences).toFixed(1);
        console.log(
          `[report] ${id} sentences=${st.sentences} mapped=${st.byStatus.mapped}(${pct(st.byStatus.mapped)}%) ` +
            `uncertain=${st.byStatus.uncertain} unmapped=${st.byStatus.unmapped} exact=${st.exact}(${pct(st.exact)}%) ` +
            `reasons=${JSON.stringify(st.byReason)} ratio med/max=${st.ratioMedian.toFixed(3)}/${st.ratioMax.toFixed(3)} ` +
            `spans med/max=${st.spansMedian}/${st.spansMax} exactMismatch=${exactMismatch} ${ms.toFixed(0)}ms`,
        );
        console.log(
          `[report] ${id} multiPage=${multiPage.length} ${JSON.stringify(statusOf(multiPage))} ` +
            `multiColumn=${multiCol.length} ${JSON.stringify(statusOf(multiCol))}`,
        );
        const samples: string[] = [];
        results.forEach((r, i) => {
          if (r.status === 'mapped' || samples.length >= 14) return;
          const s = sentences[i]!;
          const blob = candidates[i]!.textItemIds.map((tid) => byId.get(tid)!.str).join('|');
          samples.push(
            `${r.status}/${r.reason ?? '-'} d=${r.distance}/${r.length} kind=${s.kind} p${s.page}\n` +
              `    en: ${s.en.slice(0, 90)}\n    cand: ${blob.slice(0, 110)}`,
          );
        });
        console.log(`[report] ${id} non-mapped samples:\n  ${samples.join('\n  ')}`);
      }

      expect(st.sentences).toBe(sentences.length);
      expect(st.byStatus.mapped / st.sentences).toBeGreaterThan(0.9);
      expect(st.byStatus.unmapped / st.sentences).toBeLessThan(0.05);
      expect(exactMismatch).toBe(0);
      // 스팬은 후보 항목만 가리키고 항목 문자열 범위 안이며 읽기 순서를 따른다
      results.forEach((r, i) => {
        const cand = new Set(candidates[i]!.textItemIds);
        let prevKey = -1;
        for (const sp of r.sourceSpans) {
          expect(cand.has(sp.textItemId)).toBe(true);
          const item = byId.get(sp.textItemId)!;
          expect(sp.pageIndex).toBe(item.pageIndex);
          expect(sp.utf16Start).toBeGreaterThanOrEqual(0);
          expect(sp.utf16Start).toBeLessThan(sp.utf16End);
          expect(sp.utf16End).toBeLessThanOrEqual(item.str.length);
          expect(sp.normalizationMapId).toBe(`nm_${item.id}`);
          const key = item.pageIndex * 1e6 + item.index;
          expect(key).toBeGreaterThan(prevKey);
          prevKey = key;
        }
        if (r.status === 'unmapped') expect(r.sourceSpans).toEqual([]);
        else expect(r.sourceSpans.length).toBeGreaterThan(0);
      });
      // 페이지 경계 문장이 있으면 그중 mapped 문장의 스팬은 두 페이지에 걸친다
      const mappedMultiPage = multiPage.filter((s) => results[s.order]!.status === 'mapped');
      if (multiPage.length > 0) {
        expect(mappedMultiPage.length).toBeGreaterThan(0);
        for (const s of mappedMultiPage) {
          const pages = new Set(results[s.order]!.sourceSpans.map((sp) => sp.pageIndex));
          expect(pages.size).toBe(s.pages.length);
        }
      }
    },
    120_000,
  );
});
