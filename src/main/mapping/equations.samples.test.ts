import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SentenceAligner } from '@shared/mapping/align';
import { TextItemIndex, findCandidates } from '@shared/mapping/candidates';
import {
  InlineEquationDetector,
  equationStats,
  type EquationDetection,
} from '@shared/mapping/equations';
import { available, loadSample, report } from './__fixtures__/load-sample';

/**
 * 실샘플(없으면 skip)에서 인라인 수식 후보 검출 결과를 fixture(`__fixtures__/equations.<id>.json`)와 대조한다.
 * fixture는 검출·오인 목록의 기록이다(COMMIT_PLAN C1.13, PLAN 12.3 "검출 자체의 누락·오인율 별도 측정").
 * 규칙을 바꿔 결과가 달라지면 PAPERLENS_REPORT=1로 새 목록을 스크래치에 쓰고 검토한 뒤 fixture를 갱신한다.
 */
interface FixtureEntry {
  order: number;
  token: string;
  status: 'detected' | 'math_uncertain';
  rawText: string;
  warning: string | null;
  signals: string;
  en: string;
}

function toFixture(results: readonly EquationDetection[], orders: number[]): FixtureEntry[] {
  const out: FixtureEntry[] = [];
  results.forEach((r, i) => {
    r.equations.forEach((e, k) => {
      const sg = r.signals[k]!;
      out.push({
        order: orders[i]!,
        token: e.token,
        status: e.detectionStatus,
        rawText: e.rawText ?? '',
        warning: e.warning ?? null,
        signals: `font=${sg.font} symbol=${sg.symbol} script=${sg.script} weak=${sg.weak}`,
        en: r.en.length > 120 ? `${r.en.slice(0, 120)}…` : r.en,
      });
    });
  });
  return out;
}

describe.skipIf(available.length === 0)('인라인 수식 후보 검출 (실샘플)', () => {
  it.each(available)(
    '%s: 검출 목록이 fixture와 같고 자리표시자는 문장 텍스트에서 순서대로 치환된다',
    async (id) => {
      const { items, boxes, sentences, fonts } = await loadSample(id, { fonts: true });
      const byId = new Map(items.map((it) => [it.id, it]));
      const index = new TextItemIndex(items);
      const aligner = new SentenceAligner(items);
      const detector = new InlineEquationDetector(items, { fontNameOf: (f) => fonts.get(f) });
      const results = sentences.map((s) => {
        const a = aligner.align(
          s,
          findCandidates(s, index, (i) => boxes[i]),
        );
        return detector.detect({ id: s.id, en: s.en, sourceSpans: a.sourceSpans });
      });
      const st = equationStats(results);
      const fixture = toFixture(
        results,
        sentences.map((s) => s.order),
      );

      if (report) {
        console.log(`[report] ${id} ${JSON.stringify(st)}`);
        const skipped = results.flatMap((r) => r.skipped.map((s) => `${s.kind}:${s.rawText}`));
        console.log(
          `[report] ${id} skipped(${skipped.length}): ${skipped.slice(0, 40).join(' | ')}`,
        );
        for (const e of fixture)
          console.log(
            `[report] ${id} #${e.order} ${e.token} ${e.status}${e.warning ? `(${e.warning})` : ''} [${e.signals}] "${e.rawText}" ⇒ ${e.en.slice(0, 90)}`,
          );
        const out = resolve(
          process.env['PAPERLENS_REPORT_DIR'] ?? __dirname,
          `equations.${id}.report.json`,
        );
        writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
        console.log(`[report] ${id} wrote ${out}`);
      }

      // 자리표시자 치환 검증: 토큰이 문장 안에 순서대로 있고, 토큰 수는 치환된 수식 수와 같다
      for (const r of results) {
        const placed = r.equations.filter((e) => e.warning !== 'not_in_sentence_text');
        const tokens = r.en.match(/\[EQ_\d+\]/g) ?? [];
        expect(tokens).toEqual(placed.map((e) => e.token));
        for (const e of r.equations) {
          expect(e.sourceSpans.length).toBeGreaterThan(0);
          expect(e.rects.length).toBeGreaterThan(0);
          for (const sp of e.sourceSpans) expect(byId.has(sp.textItemId)).toBe(true);
        }
      }
      const fixturePath = resolve(__dirname, '__fixtures__', `equations.${id}.json`);
      if (existsSync(fixturePath)) {
        const expected = JSON.parse(readFileSync(fixturePath, 'utf8')) as FixtureEntry[];
        expect(fixture).toEqual(expected);
      } else {
        expect.soft(st.equations, `fixture 없음: ${fixturePath}`).toBeGreaterThanOrEqual(0);
      }
    },
    180_000,
  );
});
