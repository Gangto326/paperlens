import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '@shared/schema';
import { SentenceLookup, sentenceIndexOf, type TextRange } from '@shared/mapping/selection';
import { buildExtractionDocument } from '../extract/build-document';
import { available, loadSample, report } from './__fixtures__/load-sample';

const SHA = 'b'.repeat(64);

/**
 * 실샘플(없으면 skip) 3편의 document.json 위에서 선택 해석을 확인한다(COMMIT_PLAN C1.15 확인:
 * "부분 드래그가 전체 문장으로 확장되고, 여러 줄·페이지 경계 선택이 순서대로 나온다").
 * DOM 없이 스팬 offset으로 선택을 흉내 낸다 — DOM → 항목 범위 변환은 앱의 스크린샷 모드 로그로 본다.
 */
describe.skipIf(available.length === 0)('선택 해석 (실샘플)', () => {
  it.each(available)(
    '%s: 부분 드래그 → 전체 문장, 이웃·여러 줄·페이지 경계 선택이 본문 순서',
    async (id) => {
      const s = await loadSample(id, { fonts: true });
      const { document } = buildExtractionDocument({
        paper: { pdfSha256: SHA, fileName: `${id}.pdf`, importedAt: '2026-09-26T00:00:00.000Z' },
        pages: s.pages,
        sourceMap: {
          schemaVersion: SCHEMA_VERSION,
          pdfSha256: SHA,
          extractionRevision: 'rsample',
          pdfjsVersion: s.pdfjsVersion,
          textItems: s.items,
          fonts: s.fontRecords,
          normalizationMaps: [],
        },
        tei: s.tei,
        parser: { version: '0.9.1', configHash: 'cfg' },
      });
      const strOf = new Map(s.items.map((t) => [t.id, t.str]));
      const lookup = new SentenceLookup(sentenceIndexOf(document));
      const sentences = lookup.index.sentences;
      const withSpans = sentences.filter((x) => x.sourceSpans.length > 0);
      const rangeOf = (
        span: (typeof withSpans)[number]['sourceSpans'][number],
        a: number,
        b: number,
      ): TextRange => ({
        textItemId: span.textItemId,
        start: a,
        end: b,
        text: (strOf.get(span.textItemId) ?? '').slice(a, b),
      });

      // 1) 각 문장의 첫 스팬 가운데 일부만 드래그 → 그 문장이 포함되고, 대개 그 문장 하나만 나온다.
      let partialExact = 0;
      let partialOverlap = 0;
      for (const x of withSpans) {
        const sp = x.sourceSpans[0]!;
        const len = sp.utf16End - sp.utf16Start;
        const a = sp.utf16Start + Math.floor(len / 3);
        const b = Math.max(a + 1, sp.utf16End - Math.floor(len / 3));
        const r = lookup.resolveRanges([rangeOf(sp, a, b)]);
        if (r.reason === 'whitespace_only') continue;
        expect(r.sentences.map((y) => y.id)).toContain(x.id);
        if (r.sentences.length === 1) partialExact++;
        else partialOverlap++;
      }

      // 2) 이웃 문장 쌍: 앞 문장 마지막 스팬 중간 ~ 뒤 문장 첫 스팬 중간 → 둘 다, 본문 순서. 페이지 경계 쌍은 따로 센다.
      let pairs = 0;
      let pairsExact = 0;
      let pageBoundary = 0;
      let multiLine = 0;
      for (let i = 0; i + 1 < withSpans.length; i++) {
        const p = withSpans[i]!;
        const q = withSpans[i + 1]!;
        if (q.order !== p.order + 1) continue;
        const last = p.sourceSpans[p.sourceSpans.length - 1]!;
        const first = q.sourceSpans[0]!;
        const mid = (sp: typeof last) => Math.floor((sp.utf16Start + sp.utf16End) / 2);
        const ranges: TextRange[] = [
          rangeOf(first, first.utf16Start, Math.max(first.utf16Start + 1, mid(first))),
          rangeOf(last, Math.min(mid(last), last.utf16End - 1), last.utf16End),
        ];
        // 두 스팬 사이에 있는 앞 문장의 나머지 스팬은 드래그가 지나가지만, 결과에 영향이 없으므로 넣지 않는다.
        const r = lookup.resolveRanges(ranges);
        const ids = r.sentences.map((y) => y.id);
        expect(ids.indexOf(p.id)).toBeGreaterThanOrEqual(0);
        expect(ids.indexOf(q.id)).toBeGreaterThan(ids.indexOf(p.id));
        pairs++;
        if (ids.length === 2) pairsExact++;
        if (last.pageIndex !== first.pageIndex) pageBoundary++;
        if (last.textItemId !== first.textItemId) multiLine++;
      }
      expect(pairs).toBeGreaterThan(100);
      expect(pageBoundary).toBeGreaterThan(0);

      // 3) 클릭: 첫 스팬 시작 offset의 caret → 그 문장(스팬이 겹치면 시작이 가장 가까운 문장이므로 자기 자신).
      let clickOk = 0;
      for (const x of withSpans) {
        const sp = x.sourceSpans[0]!;
        const r = lookup.resolveCaret({ textItemId: sp.textItemId, offset: sp.utf16Start });
        expect(r.reason).toBe('ok');
        if (r.sentences[0]?.id === x.id) clickOk++;
      }
      expect(clickOk / withSpans.length).toBeGreaterThan(0.98);

      // 4) 사각형 조회(미연결 문장·스팬 밖 클릭용): 각 문장 첫 사각형의 중심 → 그 문장. 줄 상자가 이웃과 겹칠 수 있어 비율로 본다.
      let rectTotal = 0;
      let rectOk = 0;
      let rectExcluded = 0;
      for (const x of sentences) {
        const rc = x.rects.find((r) => r.coordinateSpace === 'pdf_user_space');
        if (!rc) continue;
        rectTotal++;
        const r = lookup.resolvePoint({
          pageIndex: rc.pageIndex,
          x: rc.x + rc.width / 2,
          y: rc.y + rc.height / 2,
        });
        if (r.reason === 'excluded_block') rectExcluded++;
        else if (r.sentences[0]?.id === x.id) rectOk++;
      }
      expect(rectOk / rectTotal).toBeGreaterThan(0.9);
      const unmapped = sentences.filter((x) => x.mappingStatus === 'unmapped');
      for (const x of unmapped) expect(x.sourceSpans.length).toBe(0);

      if (report) {
        console.log(
          `[report] ${id} sentences=${sentences.length} withSpans=${withSpans.length} partial exact=${partialExact} overlap=${partialOverlap} | pairs=${pairs} exact=${pairsExact} multiLine=${multiLine} pageBoundary=${pageBoundary} | click ok=${clickOk}/${withSpans.length} | rect ok=${rectOk}/${rectTotal} excluded=${rectExcluded} | unmapped=${unmapped.length}`,
        );
      }
    },
    120_000,
  );
});
