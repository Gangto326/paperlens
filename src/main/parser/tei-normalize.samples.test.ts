import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sampleExtraction } from '@shared/schema/fixtures';
import { validateCacheDocument } from '@shared/schema/validate';
import type { ExtractionDocument } from '@shared/schema/types';
import { normalizeTei } from './tei-normalize';

/**
 * 실제 GROBID 0.9.1-crf 출력(fixtures/tei/*.tei.xml, gitignore)에 대한 집계 대조.
 * 기대값은 정규화기와 무관하게 Python ElementTree로 TEI 원문을 세어 얻었다(C1.8 커밋 본문 참조).
 * - sentences: abstract/div/p/s + body/div/p/s(figDesc·note 안의 s 제외) + back/div/p/s
 * - sections: 1(Abstract) + body 직계 div + back의 acknowledgement·funding 안쪽 div
 * - excluded: figure + figDesc(coords 있는 s 포함) + formula + body 직계 note + biblStruct
 * fixture 파일이 없으면(다른 환경) 건너뛴다.
 */
const CASES = [
  {
    file: '2005.11401',
    sentences: 269,
    sections: 43,
    excluded: { figure: 3, table: 7, caption: 10, formula: 3, footnote: 3, bibliography: 69 },
    bibliography: 69,
    title: 'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks',
    year: 2021,
    subsectionsWithParent: 14,
  },
  {
    file: '2410.21418',
    sentences: 666,
    sections: 44,
    excluded: { figure: 31, table: 0, caption: 26, formula: 0, footnote: 0, bibliography: 131 },
    bibliography: 131,
    title: 'Large Language Models for Manufacturing',
    year: 2024,
    // head n이 "3."·없음인 div가 섞여 있어 번호 체계만으로 잇는다(3.x 아래는 없다).
    subsectionsWithParent: 29,
  },
  {
    file: '2312.06718',
    sentences: 422,
    sections: 33,
    excluded: { figure: 3, table: 0, caption: 2, formula: 0, footnote: 0, bibliography: 419 },
    bibliography: 419,
    title: 'Large Scale Foundation Models for Intelligent Manufacturing Applications: A Survey',
    year: 2023,
    subsectionsWithParent: 0,
  },
] as const;

const fixturesDir = resolve(__dirname, '../../../fixtures/tei');
const available = CASES.every((c) => existsSync(resolve(fixturesDir, `${c.file}.tei.xml`)));

describe.skipIf(!available)('normalizeTei on real GROBID samples', () => {
  for (const c of CASES) {
    it(`${c.file}: 집계가 수동 집계와 일치하고 스키마를 통과한다`, () => {
      const tei = readFileSync(resolve(fixturesDir, `${c.file}.tei.xml`), 'utf8');
      const result = normalizeTei(tei, { pdfSha256: 'a'.repeat(64), extractionRevision: 'rtest' });

      expect(result.sentences).toHaveLength(c.sentences);
      expect(result.sections).toHaveLength(c.sections);
      expect(result.bibliography).toHaveLength(c.bibliography);
      // 0건인 타입도 표에 명시하므로 기대 키로 초기화한 뒤 센다.
      const byType: Record<string, number> = Object.fromEntries(
        Object.keys(c.excluded).map((k) => [k, 0]),
      );
      for (const x of result.excludedBlocks) byType[x.type] = (byType[x.type] ?? 0) + 1;
      expect(byType).toEqual(c.excluded);
      expect(result.metadata.title).toBe(c.title);
      expect(result.metadata.year).toBe(c.year);
      expect(result.sections.filter((s) => s.parentId).length).toBe(c.subsectionsWithParent);

      // 순서·ID·섹션 연결 불변식
      result.sentences.forEach((s, i) => expect(s.order).toBe(i));
      expect(new Set(result.sentences.map((s) => s.id)).size).toBe(c.sentences);
      const sectionIds = new Set(result.sections.map((s) => s.id));
      for (const s of result.sentences) expect(sectionIds.has(s.sectionId)).toBe(true);
      expect(result.sections.reduce((n, s) => n + s.sentenceIds.length, 0)).toBe(c.sentences);
      expect(result.sentences.every((s) => s.rects.length > 0)).toBe(true);

      // 캐시 스키마(extraction/document.json) 검증
      const doc: ExtractionDocument = {
        ...sampleExtraction,
        sections: result.sections,
        sentences: result.sentences,
        excludedBlocks: result.excludedBlocks,
        bibliography: result.bibliography,
        warnings: result.warnings,
      };
      const v = validateCacheDocument('extractionDocument', doc);
      if (!v.ok) throw new Error(v.errors.slice(0, 10).join('\n'));

      if (process.env['TEI_DUMP']) {
        const boundary = result.sentences
          .filter((s) => s.warnings.some((w) => w.startsWith('boundary_')))
          .map((s) => ({ order: s.order, warnings: s.warnings, text: s.enRaw }));
        writeFileSync(
          resolve(process.env['TEI_DUMP'], `${c.file}.summary.json`),
          JSON.stringify(
            {
              metadata: result.metadata,
              warnings: result.warnings,
              sections: result.sections.map((s) => ({
                title: s.title,
                parent: s.parentId,
                n: s.sentenceIds.length,
              })),
              excludedByType: byType,
              sample: result.sentences.slice(0, 3),
              fragments: result.sentences.filter((s) => s.kind === 'fragment').length,
              boundary,
              bib: result.bibliography.slice(0, 2),
              bibCitedCount: result.bibliography.filter((b) => b.citingSentenceIds.length > 0)
                .length,
              excludedSample: result.excludedBlocks
                .filter((x) => x.type !== 'bibliography')
                .slice(0, 6),
            },
            null,
            1,
          ),
        );
      }
    });
  }
});
