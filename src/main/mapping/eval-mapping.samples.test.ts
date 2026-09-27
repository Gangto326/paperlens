import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '@shared/schema';
import { SentenceLookup, sentenceIndexOf } from '@shared/mapping/selection';
import type { TextItemRecord } from '@shared/schema/types';
import { buildExtractionDocument } from '../extract/build-document';
import { available, loadSample } from './__fixtures__/load-sample';
import {
  compareSpans,
  itemsDigest,
  keyOffsets,
  keyPositions,
  outcomeOf,
  parseSpans,
  textSha,
  type MappingOutcome,
  type TruthEntry,
  type TruthFile,
} from './truth';

/**
 * 정답 매핑 표본과 실제 매핑 결과를 비교한다(C1.21, PLAN 12.3 "문장 선택 매핑"). `npm run eval:mapping`.
 *
 * - 스팬: 문장의 sourceSpans가 정답과 같은 글자를 덮는가(비교 규칙은 truth.ts).
 * - 선택: 정답 글자의 처음·가운데·끝을 클릭하고 가운데 구간을 드래그했을 때 그 문장이 나오는가.
 * - 조용한 오매핑: mapped인데 스팬이 다르거나, 경고 없이 다른 문장이 나오는 경우. 0건이어야 한다.
 *
 * 샘플 PDF·TEI가 없으면 건너뛴다. 정답 파일은 커밋되어 있으므로 구성 검사는 항상 돈다.
 * PAPERLENS_TRUTH_DUMP=<dir>이면 정답 생성기(scripts/mapping-truth/build-truth.py) 입력을 쓴다.
 * 덤프에는 매핑 결과(sourceSpans·mappingStatus)와 GROBID 좌표를 넣지 않는다 — 정답이 알고리즘을 베끼지 않게.
 */
const SHA = 'c'.repeat(64);
const truthDir = resolve(__dirname, '../../../fixtures/truth');
const dumpDir = process.env['PAPERLENS_TRUTH_DUMP'];
const SAMPLE_IDS = ['2005.11401', '2312.06718', '2410.21418'];

function readTruth(id: string): TruthFile | null {
  const path = resolve(truthDir, `mapping.${id}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as TruthFile;
}

interface Tally {
  total: number;
  correct: number;
  flagged: number;
  silent: number;
}
const emptyTally = (): Tally => ({ total: 0, correct: 0, flagged: 0, silent: 0 });
function add(map: Map<string, Tally>, key: string, outcome: MappingOutcome): void {
  const t = map.get(key) ?? emptyTally();
  t.total++;
  t[outcome]++;
  map.set(key, t);
}
const pct = (n: number, d: number) => (d === 0 ? '-' : `${((100 * n) / d).toFixed(2)}%`);
const line = (name: string, t: Tally) =>
  `${name.padEnd(18)} n=${String(t.total).padStart(4)} 일치=${String(t.correct).padStart(4)} (${pct(t.correct, t.total)}) 표시된 불일치=${t.flagged} 조용한 오매핑=${t.silent}`;

/** 글자 위치의 대략적인 user space 좌표(스팬 밖 클릭의 사각형 조회용). 가로쓰기 항목을 전제한다. */
function pointOf(item: TextItemRecord, offset: number) {
  const ratio = item.str.length === 0 ? 0 : (offset + 0.5) / item.str.length;
  return {
    pageIndex: item.pageIndex,
    x: item.transform[4] + item.width * ratio,
    y: item.transform[5] + item.height / 2,
  };
}

describe('정답 매핑 표본의 구성', () => {
  const files = SAMPLE_IDS.map(readTruth).filter((f): f is TruthFile => f !== null);

  it('3편이 있고, 읽어서 확인한 문장이 합쳐 200개 이상이며 어려운 사례를 포함한다', () => {
    expect(files.length).toBe(3);
    const checked = files.flatMap((f) => f.entries.filter((e) => e.verification !== 'auto'));
    expect(checked.length).toBeGreaterThanOrEqual(200);
    const tags = new Set(checked.flatMap((e) => e.tags));
    for (const tag of ['page_boundary', 'column_boundary', 'repeated', 'inline_math'])
      expect(tags.has(tag)).toBe(true);
  });

  it.each(files.map((f) => [f.paper.id, f] as const))(
    '%s: 스팬 형식이 맞고 order가 겹치지 않는다',
    (_id, file) => {
      expect(file.schemaVersion).toBe(1);
      expect(file.paper.sha256).toMatch(/^[0-9a-f]{64}$/);
      const orders = new Set<number>();
      for (const e of file.entries) {
        expect(orders.has(e.order)).toBe(false);
        orders.add(e.order);
        expect(parseSpans(e.spans).length).toBeGreaterThan(0);
        parseSpans(e.optional);
        expect(e.textSha).toMatch(/^[0-9a-f]{16}$/);
      }
    },
  );
});

describe.skipIf(available.length === 0)('정답 대비 매핑 정확도 (실샘플)', () => {
  it.each(available)(
    '%s: 조용한 오매핑 0건',
    async (id) => {
      const s = await loadSample(id, { fonts: true });
      const { document } = buildExtractionDocument({
        paper: { pdfSha256: SHA, fileName: `${id}.pdf`, importedAt: '2026-09-27T00:00:00.000Z' },
        pages: s.pages,
        sourceMap: {
          schemaVersion: SCHEMA_VERSION,
          pdfSha256: SHA,
          extractionRevision: 'reval',
          pdfjsVersion: s.pdfjsVersion,
          textItems: s.items,
          fonts: s.fontRecords,
          normalizationMaps: [],
        },
        tei: s.tei,
        parser: { version: '0.9.1', configHash: 'cfg' },
      });
      const sentences = [...document.sentences].sort((a, b) => a.order - b.order);

      if (dumpDir) {
        mkdirSync(dumpDir, { recursive: true });
        writeFileSync(
          resolve(dumpDir, `${id}.dump.json`),
          JSON.stringify({
            id,
            pdfjsVersion: s.pdfjsVersion,
            teiSha256: createHash('sha256').update(s.tei, 'utf8').digest('hex'),
            itemsDigest: itemsDigest(s.items),
            pages: s.pages.map((p) => ({ width: p.width, height: p.height })),
            items: s.items,
            sentences: sentences.map((x) => ({
              order: x.order,
              kind: x.kind,
              page: x.page,
              pages: x.pages,
              enRaw: x.enRaw,
            })),
          }),
        );
      }

      const truth = readTruth(id);
      if (!truth) {
        console.log(`[eval] ${id} 정답 파일 없음(fixtures/truth/mapping.${id}.json)`);
        return;
      }

      // 정답이 지금의 추출 결과 위에서 만들어졌는지 먼저 본다. 낡았으면 수치를 내지 않는다.
      expect(itemsDigest(s.items), '텍스트 항목이 정답을 만들 때와 다르다').toBe(
        truth.source.itemsDigest,
      );
      expect(sentences.length).toBe(truth.parser.sentences);

      const itemOf = new Map(s.items.map((t) => [t.id, t]));
      const strOf = (tid: string) => itemOf.get(tid)?.str;
      const lookup = new SentenceLookup(sentenceIndexOf(document));

      const byTier = new Map<string, Tally>();
      const byTag = new Map<string, Tally>();
      const selection = {
        total: 0,
        hit: 0,
        exact: 0,
        byRect: 0,
        none: 0,
        warned: 0,
        silentWrong: 0,
      };
      const details: string[] = [];
      let stale = 0;

      const evaluate = (e: TruthEntry) => {
        const sentence = sentences[e.order];
        if (sentence?.order !== e.order || textSha(sentence.enRaw) !== e.textSha) {
          stale++;
          return;
        }
        const truthRanges = parseSpans(e.spans);
        const optional = keyOffsets(parseSpans(e.optional), strOf);
        const predicted = keyOffsets(
          sentence.sourceSpans.map((sp) => ({
            textItemId: sp.textItemId,
            start: sp.utf16Start,
            end: sp.utf16End,
          })),
          strOf,
        );
        const cmp = compareSpans(keyOffsets(truthRanges, strOf), optional, predicted);
        const outcome = outcomeOf(sentence.mappingStatus, cmp.verdict);
        const tier = e.verification === 'auto' ? 'auto' : 'checked';
        add(byTier, tier, outcome);
        add(byTier, 'all', outcome);
        if (tier === 'checked') {
          for (const tag of e.tags.length > 0 ? e.tags : ['plain']) add(byTag, tag, outcome);
        }
        if (outcome !== 'correct') {
          details.push(
            `  #${e.order} ${tier} ${sentence.mappingStatus} ${cmp.verdict} 빠짐=${cmp.missing} 넘침=${cmp.extra} 정답=${cmp.truth} [${e.tags.join(',')}] ${e.head}`,
          );
        }

        // 선택 흉내는 읽어서 확인한 문장에만 한다(PLAN 12.3 "표본 선택").
        if (tier !== 'checked') return;
        const pos = keyPositions(truthRanges, strOf);
        if (pos.length === 0) return;
        const picks = [pos[0]!, pos[Math.floor(pos.length / 2)]!, pos[pos.length - 1]!];
        const record = (
          ids: string[],
          warnedAll: boolean,
          byRect: boolean,
          kind: string,
          at: string,
        ) => {
          selection.total++;
          if (ids.includes(sentence.id)) {
            selection.hit++;
            if (ids.length === 1) selection.exact++;
            if (byRect) selection.byRect++;
          } else if (ids.length === 0) {
            selection.none++;
          } else if (warnedAll) {
            selection.warned++;
          } else {
            selection.silentWrong++;
            details.push(`  #${e.order} 선택(${kind} ${at}) → 다른 문장 ${ids.join(',')}`);
          }
        };
        const warned = (r: ReturnType<SentenceLookup['resolveCaret']>) =>
          r.byRect || r.sentences.every((x) => x.mappingStatus !== 'mapped');
        for (const p of picks) {
          const item = itemOf.get(p.textItemId)!;
          const r = lookup.resolveCaret(
            { textItemId: p.textItemId, offset: p.offset },
            pointOf(item, p.offset),
          );
          record(
            r.sentences.slice(0, 1).map((x) => x.id),
            warned(r),
            r.byRect,
            '클릭',
            `${p.textItemId}:${p.offset}`,
          );
        }
        // 드래그: 가운데 글자가 있는 항목 안에서 정답 범위의 가운데 1/3
        const mid = picks[1]!;
        const range = truthRanges.find(
          (r) => r.textItemId === mid.textItemId && r.start <= mid.offset && mid.offset < r.end,
        )!;
        const third = Math.floor((range.end - range.start) / 3);
        const a = range.start + third;
        const b = Math.max(a + 1, range.end - third);
        const text = (strOf(range.textItemId) ?? '').slice(a, b);
        if (text.trim() !== '') {
          const r = lookup.resolveRanges([
            { textItemId: range.textItemId, start: a, end: b, text },
          ]);
          record(
            r.sentences.map((x) => x.id),
            warned(r),
            r.byRect,
            '드래그',
            `${range.textItemId}:${a}-${b}`,
          );
        }
      };
      for (const e of truth.entries) evaluate(e);

      const out: string[] = [];
      out.push(
        `[eval] ${id} ${truth.paper.arxivVersion} ${truth.paper.pages}쪽 문장 ${sentences.length}개, 정답 ${truth.entries.length}개(낡은 항목 ${stale})`,
      );
      out.push(`  스팬 ${line('확인한 표본', byTier.get('checked') ?? emptyTally())}`);
      out.push(`  스팬 ${line('자동(보조)', byTier.get('auto') ?? emptyTally())}`);
      out.push(`  스팬 ${line('전체', byTier.get('all') ?? emptyTally())}`);
      for (const [tag, t] of [...byTag].sort((x, y) => x[0].localeCompare(y[0])))
        out.push(`    태그 ${line(tag, t)}`);
      out.push(
        `  선택 n=${selection.total} 그 문장=${selection.hit} (${pct(selection.hit, selection.total)}) 그 문장만=${selection.exact} 사각형 조회로 찾음=${selection.byRect} 결과 없음=${selection.none} 경고와 함께 다른 문장=${selection.warned} 조용히 다른 문장=${selection.silentWrong}`,
      );
      if (details.length > 0) out.push(' 불일치 목록', ...details);
      console.log(out.join('\n'));
      if (dumpDir) {
        writeFileSync(
          resolve(dumpDir, `${id}.eval.json`),
          JSON.stringify({
            id,
            byTier: Object.fromEntries(byTier),
            byTag: Object.fromEntries(byTag),
            selection,
            stale,
          }),
        );
      }

      expect(stale).toBe(0);
      expect((byTier.get('all') ?? emptyTally()).silent).toBe(0);
      expect(selection.silentWrong).toBe(0);
    },
    180_000,
  );
});
