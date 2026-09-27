import { promises as fs } from 'node:fs';
import { relative } from 'node:path';
import type { MappingResult, ReadDocumentResult } from '@shared/ipc';
import { sentenceIndexOf } from '@shared/mapping/selection';
import type { Page } from '@shared/schema';
import { CacheReadError, type PaperCacheStore } from '../cache/paper-cache-store';
import { stateAfterExtractionStep } from '../state/paper-state';
import { buildExtractionDocument, type BuildDocumentResult } from './build-document';

export interface BuildAndSaveOptions {
  fileName: string;
  originalPath?: string | null;
  /** saveTextItems가 돌려준 pages(textQuality 포함). 같은 rev의 것이어야 한다. */
  pages: Page[];
  parserVersion: string | null;
  parserConfigHash: string;
  now?: Date;
}

/**
 * 추출 오케스트레이션의 마지막 단계(C1.14): manifest의 현재 rev 아래 source-map.json(C1.5)과
 * original.tei.xml(C1.7)을 읽어 document.json을 조립·검증·원자 저장하고 manifest를 `mapping`으로 옮긴다.
 *
 * 상태 전이: imported(initPaper) → extracting(saveTextItems) → mapping(여기, document.json 확정).
 * PLAN 8.3대로 결과 파일과 해시를 먼저 확정한 뒤 manifest에 완료를 표시한다. 같은 입력이면 같은 rev·같은 ID가
 * 나오므로 재실행은 같은 경로를 덮어쓴다(importedAt만 실행 시각).
 */
export async function buildAndSaveDocument(
  store: PaperCacheStore,
  pdfSha256: string,
  opts: BuildAndSaveOptions,
): Promise<MappingResult & { build: BuildDocumentResult }> {
  const t0 = Date.now();
  const now = opts.now ?? new Date();
  const manifest = await store.readManifest(pdfSha256);
  const rev = manifest.currentExtractionRevision;
  if (!rev) throw new Error(`추출 revision이 없습니다 (state=${manifest.state})`);

  const sourceMapPath = store.extractionPath(pdfSha256, rev, 'source-map.json');
  const recorded = manifest.files.find(
    (f) => f.path === relative(store.paperDir(pdfSha256), sourceMapPath),
  );
  const sourceMap = await store.readJson('sourceMapDocument', sourceMapPath, recorded?.sha256);

  const teiPath = store.extractionPath(pdfSha256, rev, 'original.tei.xml');
  let tei: string;
  try {
    tei = await fs.readFile(teiPath, 'utf8');
  } catch {
    throw new CacheReadError(teiPath, 'missing', ['구조 분석(GROBID) 결과가 아직 없습니다']);
  }

  const build = buildExtractionDocument({
    paper: {
      pdfSha256,
      fileName: opts.fileName,
      originalPath: opts.originalPath ?? null,
      importedAt: now.toISOString(),
    },
    pages: opts.pages,
    sourceMap,
    tei,
    parser: { version: opts.parserVersion, configHash: opts.parserConfigHash },
  });

  const documentPath = store.extractionPath(pdfSha256, rev, 'document.json');
  const sha = await store.writeJson('extractionDocument', documentPath, build.document);
  await store.updateManifest(
    pdfSha256,
    (m) => {
      store.recordFile(m, pdfSha256, documentPath, sha);
      m.state = stateAfterExtractionStep(m.state, 'mapping', m.currentExtractionRevision === rev);
      m.currentExtractionRevision = rev;
    },
    now,
  );

  const { alignment, equations, readingOrder } = build.stats;
  return {
    extractionRevision: rev,
    documentPath,
    sentenceCount: build.document.sentences.length,
    mapped: alignment.byStatus.mapped,
    uncertain: alignment.byStatus.uncertain,
    unmapped: alignment.byStatus.unmapped,
    equationCount: equations.equations,
    readingOrderMismatches: readingOrder.mismatches,
    warnings: build.document.warnings,
    elapsedMs: Date.now() - t0,
    build,
  };
}

/**
 * renderer의 선택 해석·표시용 색인(C1.15): manifest의 현재 rev 아래 document.json을 해시 대조·스키마 검증해 읽고
 * 문장 요약만 돌려준다. document.json이 아직 없으면(GROBID 미실행 등) CacheReadError('missing').
 */
export async function readSentenceIndex(
  store: PaperCacheStore,
  pdfSha256: string,
): Promise<ReadDocumentResult> {
  const manifest = await store.readManifest(pdfSha256);
  const rev = manifest.currentExtractionRevision;
  if (!rev) throw new Error(`추출 revision이 없습니다 (state=${manifest.state})`);
  const documentPath = store.extractionPath(pdfSha256, rev, 'document.json');
  const recorded = manifest.files.find(
    (f) => f.path === relative(store.paperDir(pdfSha256), documentPath),
  );
  if (!recorded) {
    throw new CacheReadError(documentPath, 'missing', ['문장 연결(document.json)이 아직 없습니다']);
  }
  const doc = await store.readJson('extractionDocument', documentPath, recorded.sha256);
  // GROBID 없이 캐시의 document.json을 쓰는 경로(C1.16)에서는 buildDocument가 돌지 않는다.
  // 문장 연결이 확정돼 있는데 상태가 extracting에 머물러 있으면 mapping으로 올린다.
  if (manifest.state === 'extracting') {
    await store.updateManifest(pdfSha256, (m) => {
      if (m.state === 'extracting' && m.currentExtractionRevision === rev) m.state = 'mapping';
    });
  }
  return { ...sentenceIndexOf(doc), documentPath };
}
