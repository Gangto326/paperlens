import type { TextExtractionPayload, TextExtractionResult } from '@shared/ipc';
import { SCHEMA_VERSION, type Failure, type Page, type TextQuality } from '@shared/schema';
import { createNormalizationMap } from '@shared/normalize/normalizer';
import { classifyDocument, classifyPage, haltsPipeline, pageTextStats } from '@shared/text-quality';
import type { PaperCacheStore } from '../cache/paper-cache-store';
import { computeExtractionRevision, revisionInputFor } from './revision';

const SHA256_RE = /^[0-9a-f]{64}$/;

/** IPC로 들어온 값의 겉모양만 확인한다. 항목 내부는 source-map 스키마 검증이 맡는다. */
export function parseTextExtractionPayload(value: unknown): TextExtractionPayload {
  if (typeof value !== 'object' || value === null) throw new Error('payload must be an object');
  const v = value as Record<string, unknown>;
  if (typeof v['pdfSha256'] !== 'string' || !SHA256_RE.test(v['pdfSha256'])) {
    throw new Error('pdfSha256 must be a sha256 hex string');
  }
  if (typeof v['pdfjsVersion'] !== 'string' || !v['pdfjsVersion']) {
    throw new Error('pdfjsVersion must be a non-empty string');
  }
  if (typeof v['textExtractorVersion'] !== 'string' || !v['textExtractorVersion']) {
    throw new Error('textExtractorVersion must be a non-empty string');
  }
  if (!Array.isArray(v['pages']) || !Array.isArray(v['textItems']) || !Array.isArray(v['fonts'])) {
    throw new Error('pages, textItems and fonts must be arrays');
  }
  return v as unknown as TextExtractionPayload;
}

/** 항목 ID가 `t_<page>_<index>` 규칙과 페이지 범위에 맞는지 확인한다. 어긋나면 저장하지 않는다. */
function assertConsistent(payload: TextExtractionPayload): void {
  payload.pages.forEach((p, i) => {
    if (p.pageIndex !== i) throw new Error(`pages[${i}].pageIndex=${p.pageIndex} (순서 불일치)`);
  });
  const seen = new Set<string>();
  for (const item of payload.textItems) {
    const expected = `t_${item.pageIndex}_${item.index}`;
    if (item.id !== expected) throw new Error(`textItem id ${item.id} ≠ ${expected}`);
    if (item.pageIndex < 0 || item.pageIndex >= payload.pages.length) {
      throw new Error(`textItem ${item.id}: pageIndex 범위 밖`);
    }
    if (seen.has(item.id)) throw new Error(`textItem id 중복: ${item.id}`);
    seen.add(item.id);
  }
}

/**
 * renderer가 모은 텍스트 항목을 extraction/<rev>/source-map.json에 저장하고 텍스트 품질을 판정한다.
 * - normalizationMaps는 항목마다 하나(`nm_<textItemId>`). 정규화 텍스트는 파일에 쓰지 않고
 *   같은 NORMALIZER_VERSION으로 다시 계산한다.
 * - needs_ocr·garbled이면 manifest.state=failed + errors에 기록하고 halted=true를 돌려준다.
 * - 그 외에는 state=extracting, currentExtractionRevision=rev. 다음 단계(GROBID)는 C1.6~.
 * pages는 여기서 파일에 쓰지 않고 textQuality를 채워 돌려준다. document.json은 C1.14(build-document·document-store)가
 * GROBID 결과와 합쳐 확정한다.
 */
export interface SaveTextItemsOptions {
  /** GROBID 이미지 태그+요청 설정 해시(GrobidClient.parserConfigHash). extraction revision 입력이다. */
  parserConfigHash: string;
  now?: Date;
}

export async function saveTextItems(
  store: PaperCacheStore,
  payload: TextExtractionPayload,
  opts: SaveTextItemsOptions,
): Promise<TextExtractionResult> {
  const now = opts.now ?? new Date();
  assertConsistent(payload);
  const { pdfSha256 } = payload;

  const strsByPage: string[][] = payload.pages.map(() => []);
  for (const item of payload.textItems) strsByPage[item.pageIndex]!.push(item.str);
  const pages: Page[] = payload.pages.map((p, i) => ({
    ...p,
    textQuality: classifyPage(pageTextStats(i, strsByPage[i]!)),
  }));
  const textQuality: TextQuality = classifyDocument(pages.map((p) => p.textQuality));
  const halted = haltsPipeline(textQuality);

  const extractionRevision = computeExtractionRevision(
    revisionInputFor({
      pdfjsVersion: payload.pdfjsVersion,
      textExtractorVersion: payload.textExtractorVersion,
      parserConfigHash: opts.parserConfigHash,
    }),
  );
  const sourceMapPath = store.extractionPath(pdfSha256, extractionRevision, 'source-map.json');
  const fileSha = await store.writeJson('sourceMapDocument', sourceMapPath, {
    schemaVersion: SCHEMA_VERSION,
    pdfSha256,
    extractionRevision,
    pdfjsVersion: payload.pdfjsVersion,
    textItems: payload.textItems,
    fonts: payload.fonts,
    normalizationMaps: payload.textItems.map(
      (item) => createNormalizationMap(item.str, `nm_${item.id}`).map,
    ),
  });

  await store.updateManifest(
    pdfSha256,
    (m) => {
      store.recordFile(m, pdfSha256, sourceMapPath, fileSha);
      if (halted) {
        const failure: Failure = {
          id: `extract_${textQuality}_${extractionRevision}`,
          stage: 'extract',
          code: textQuality === 'needs_ocr' ? 'needs_ocr' : 'text_garbled',
          message:
            textQuality === 'needs_ocr'
              ? '유효한 텍스트가 거의 없습니다. 스캔 PDF로 보이며 OCR은 지원하지 않습니다.'
              : '텍스트 글자가 심하게 깨져 있습니다(글꼴 인코딩 문제로 추정).',
          retryable: false,
          attempt: 1,
          occurredAt: now.toISOString(),
        };
        m.errors = [...m.errors.filter((e) => e.id !== failure.id), failure];
        m.state = 'failed';
        m.currentExtractionRevision = null;
      } else {
        m.state = 'extracting';
        m.currentExtractionRevision = extractionRevision;
      }
    },
    now,
  );

  return {
    extractionRevision,
    sourceMapPath,
    itemCount: payload.textItems.length,
    pages,
    textQuality,
    halted,
  };
}
