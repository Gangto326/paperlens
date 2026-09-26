import { describe, expect, it } from 'vitest';
import { validateCacheDocument } from '@shared/schema';
import { NORMALIZER_VERSION } from '@shared/normalize/normalizer';
import { TINY_SHA, TINY_TEI, tinyPages, tinySourceMap } from './__fixtures__/tiny-paper';
import {
  READING_ORDER_WARNING,
  buildExtractionDocument,
  versionOfImageTag,
  type BuildDocumentInput,
} from './build-document';
import { SEGMENTER_VERSION } from './revision';

const NOW = '2026-09-26T10:00:00.000Z';

function input(over: Partial<BuildDocumentInput> = {}): BuildDocumentInput {
  return {
    paper: {
      pdfSha256: TINY_SHA,
      fileName: 'tiny.pdf',
      originalPath: '/x/tiny.pdf',
      importedAt: NOW,
    },
    pages: tinyPages(),
    sourceMap: tinySourceMap(),
    tei: TINY_TEI,
    parser: { version: '0.9.1', configHash: 'cfg0' },
    ...over,
  };
}

describe('buildExtractionDocument', () => {
  it('스키마를 통과하는 document를 만들고 paper·pipeline을 채운다', () => {
    const { document } = buildExtractionDocument(input());
    expect(validateCacheDocument('extractionDocument', document).ok).toBe(true);
    expect(document.paper).toEqual({
      id: `paper_${TINY_SHA.slice(0, 16)}`,
      pdfSha256: TINY_SHA,
      fileName: 'tiny.pdf',
      originalPath: '/x/tiny.pdf',
      title: 'Tiny Paper',
      authors: ['Ada Lovelace'],
      year: 2024,
      doi: '10.1000/tiny',
      pageCount: 1,
      importedAt: NOW,
    });
    expect(document.pipeline).toEqual({
      extractionRevision: 'rtiny',
      parserName: 'grobid',
      parserVersion: '0.9.1',
      parserConfigHash: 'cfg0',
      pdfjsVersion: '6.3.289',
      normalizerVersion: NORMALIZER_VERSION,
      segmenterVersion: SEGMENTER_VERSION,
    });
    expect(document.pages).toEqual(tinyPages());
    expect(document.sections.map((s) => s.title)).toEqual(['Introduction']);
    expect(document.bibliography).toHaveLength(1);
    expect(document.bibliography[0]?.title).toBe('Ref title');
  });

  it('문장마다 후보→정렬→수식 검출을 이어 sourceSpans·상태·en·user space rects를 채운다', () => {
    const { document, stats } = buildExtractionDocument(input());
    const [s1, , s3, , s5] = document.sentences;
    expect(document.sentences).toHaveLength(5);
    expect(document.sentences.slice(0, 4).map((s) => s.mappingStatus)).toEqual([
      'mapped',
      'mapped',
      'mapped',
      'mapped',
    ]);
    expect(s1!.mappingConfidence).toBe(1);
    expect(s1!.sourceSpans.map((sp) => sp.textItemId)).toEqual(['t_0_1']);
    // GROBID (100, 100, 200×10) → user space: y = 792 − 110 = 682
    expect(s1!.rects).toEqual([
      expect.objectContaining({
        pageIndex: 0,
        x: 100,
        y: 682,
        width: 200,
        height: 10,
        coordinateSpace: 'pdf_user_space',
      }),
    ]);
    // 인라인 수식: enRaw 보존, en에는 자리표시자
    expect(s3!.enRaw).toBe('We define x ∈ R here.');
    expect(s3!.en).toBe('We define [EQ_1] here.');
    expect(s3!.equations).toHaveLength(1);
    expect(s3!.equations[0]).toMatchObject({
      id: `${s3!.id}_eq1`,
      token: '[EQ_1]',
      rawText: 'x ∈ R',
      detectionStatus: 'detected',
    });
    expect(s3!.equations[0]!.rects[0]?.coordinateSpace).toBe('pdf_user_space');
    // 없는 페이지의 문장: 후보 0 → unmapped, 사각형은 변환하지 못해 원본 그대로 + 경고
    expect(s5!.mappingStatus).toBe('unmapped');
    expect(s5!.sourceSpans).toEqual([]);
    expect(s5!.rects[0]?.coordinateSpace).toBe('grobid_top_left_pdf_units');
    expect(s5!.warnings).toEqual(
      expect.arrayContaining([
        'candidates:page_missing',
        'alignment:no_candidates',
        'rect_not_transformed',
      ]),
    );
    expect(stats.candidates.zero).toBe(1);
    expect(stats.alignment.byStatus).toEqual({ mapped: 4, uncertain: 0, unmapped: 1 });
    expect(stats.equations.equations).toBe(1);
  });

  it('같은 문단의 이웃 문장이 PDF 항목 순서에서 거꾸로면 두 문장에 읽기 순서 경고를 남긴다', () => {
    const { document, stats } = buildExtractionDocument(input());
    const [s1, s2, s3, s4] = document.sentences;
    expect(stats.readingOrder).toEqual({ checked: 2, mismatches: 1 });
    expect(s1!.warnings).not.toContain(READING_ORDER_WARNING);
    expect(s2!.warnings).not.toContain(READING_ORDER_WARNING);
    expect(s3!.warnings).toContain(READING_ORDER_WARNING);
    expect(s4!.warnings).toContain(READING_ORDER_WARNING);
    expect(document.warnings).toContain(`${READING_ORDER_WARNING}=1`);
  });

  it('제외 블록 사각형도 user space로 옮기고, 통계의 0건 사유·비정상 건수를 문서 경고로 남긴다', () => {
    const { document } = buildExtractionDocument(input());
    const fig = document.excludedBlocks.find((b) => b.type === 'figure');
    expect(fig?.rects[0]).toMatchObject({ x: 100, y: 392, width: 200, height: 100 });
    expect(fig?.rects[0]?.coordinateSpace).toBe('pdf_user_space');
    expect(document.warnings).toEqual(
      expect.arrayContaining(['candidates_zero:page_missing=1', 'alignment_unmapped=1']),
    );
    expect(document.warnings).not.toContain('parser_version_unknown');
  });

  it('파서 버전을 모르거나 안내한 이미지 태그와 다르면 경고한다', () => {
    expect(versionOfImageTag('grobid/grobid:0.9.1-crf')).toBe('0.9.1');
    expect(versionOfImageTag('grobid/grobid:latest')).toBeNull();
    const unknown = buildExtractionDocument(input({ parser: { version: null, configHash: 'c' } }));
    expect(unknown.document.pipeline.parserVersion).toBe('unknown');
    expect(unknown.document.warnings).toContain('parser_version_unknown');
    const other = buildExtractionDocument(
      input({ parser: { version: '0.8.2-SNAPSHOT', configHash: 'c' } }),
    );
    expect(other.document.warnings).toContain('parser_version_mismatch:0.8.2-SNAPSHOT!=0.9.1');
    const ok = buildExtractionDocument(
      input({ parser: { version: '0.9.1', configHash: 'c', imageTag: 'x/y:0.9.1' } }),
    );
    expect(ok.document.warnings.some((w) => w.startsWith('parser_version'))).toBe(false);
  });

  it('같은 입력이면 같은 문서(ID·스팬·경고 포함), rev가 다르면 다른 ID', () => {
    const a = buildExtractionDocument(input()).document;
    const b = buildExtractionDocument(input()).document;
    expect(b).toEqual(a);
    const c = buildExtractionDocument(input({ sourceMap: tinySourceMap('rother') })).document;
    expect(c.sentences[0]?.id).not.toBe(a.sentences[0]?.id);
    expect(c.sentences.map((s) => s.en)).toEqual(a.sentences.map((s) => s.en));
  });

  it('source-map의 pdfSha256이 다르거나 페이지가 없으면 조립하지 않는다', () => {
    expect(() =>
      buildExtractionDocument(
        input({ sourceMap: { ...tinySourceMap(), pdfSha256: 'c'.repeat(64) } }),
      ),
    ).toThrow(/pdfSha256/);
    expect(() => buildExtractionDocument(input({ pages: [] }))).toThrow(/페이지/);
  });
});
