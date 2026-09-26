import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, validateCacheDocument } from '@shared/schema';
import { buildExtractionDocument } from '../extract/build-document';
import { available, loadSample, report } from './__fixtures__/load-sample';

const SHA = 'a'.repeat(64);

/**
 * 실샘플(없으면 skip) 3편을 document.json으로 조립한다(COMMIT_PLAN C1.14 확인: "샘플 3편이 에러 없이 mapping 완료.
 * 재실행 시 같은 rev·같은 ID"). rev는 입력이므로 여기서는 같은 입력 → 같은 문서(ID·스팬·경고)를 확인한다.
 */
describe.skipIf(available.length === 0)('document.json 조립 (실샘플)', () => {
  it.each(available)(
    '%s: 스키마 통과, 모든 문장 사각형이 user space, 재실행 시 같은 문서',
    async (id) => {
      const s = await loadSample(id, { fonts: true });
      const build = () =>
        buildExtractionDocument({
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
      const { document, stats } = build();
      const v = validateCacheDocument('extractionDocument', document);
      expect(v.ok, v.ok ? '' : v.errors.join('; ')).toBe(true);
      expect(document.sentences.length).toBe(s.sentences.length);
      expect(new Set(document.sentences.map((x) => x.id)).size).toBe(document.sentences.length);
      for (const sentence of document.sentences) {
        for (const r of sentence.rects) expect(r.coordinateSpace).toBe('pdf_user_space');
        expect(sentence.en.includes('\n')).toBe(false);
        // 문장 텍스트에서 자리를 찾은 수식(not_in_sentence_text 경고 없음)이 하나라도 있으면 en이 바뀐다.
        if (sentence.equations.some((e) => !e.warning))
          expect(sentence.en).not.toBe(sentence.enRaw);
      }
      for (const block of document.excludedBlocks) {
        for (const r of block.rects) expect(r.coordinateSpace).toBe('pdf_user_space');
      }
      const mappedRatio = stats.alignment.byStatus.mapped / stats.alignment.sentences;
      expect(mappedRatio).toBeGreaterThan(0.95);

      const again = build().document;
      expect(again).toEqual(document);

      if (report) {
        const order = document.sentences.filter((x) =>
          x.warnings.includes('reading_order_mismatch'),
        );
        console.log(
          `[report] ${id} sentences=${document.sentences.length} ${JSON.stringify(stats.alignment.byStatus)} equations=${stats.equations.equations} readingOrder=${JSON.stringify(stats.readingOrder)} warnings=${JSON.stringify(document.warnings)}`,
        );
        for (const x of order.slice(0, 12)) {
          console.log(
            `[report]   order#${x.order} p${x.page} ${x.mappingStatus} ${x.enRaw.slice(0, 70)}`,
          );
        }
      }
    },
    120_000,
  );
});
