import 'pdfjs-dist/web/pdf_viewer.css';
import type { OpenedPdf } from '@shared/ipc';
import { collectTextItems, TEXT_EXTRACTOR_VERSION } from './extract/text-items';
import { rangesFromSelection } from './viewer/dom-selection';
import { PdfViewer } from './viewer/pdf-viewer';
import { SelectionController, type SelectionEvent } from './viewer/selection-controller';
import { PDFJS_VERSION, type PDFDocumentProxy } from './viewer/pdfjs';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} 없음`);
  return el as T;
};

const statusEl = $('status');
const titleEl = $('doc-title');
const zoomLabel = $('zoom-label');
const viewerEl = $('viewer');
const viewer = new PdfViewer({ container: viewerEl });
const selection = new SelectionController(viewer, viewerEl);

function setStatus(text: string): void {
  statusEl.textContent = text;
}

async function openPdf(): Promise<void> {
  const result = await window.paperlens.openPdfDialog();
  if (result.canceled) return;
  await loadOpened(result);
}

async function loadOpened(result: OpenedPdf): Promise<void> {
  setStatus(`읽는 중… ${result.fileName}`);
  selection.setIndex(null);
  const t0 = performance.now();
  const bytes = await window.paperlens.readPdfBytes(result.pdfSha256);
  const doc = await viewer.load(bytes);
  titleEl.textContent = `${result.fileName} · ${doc.numPages}쪽 · ${result.pdfSha256.slice(0, 12)}…`;
  const ms = Math.round(performance.now() - t0);
  setStatus(`열림 (${ms}ms).`);
  console.info(`[paperlens] loaded ${result.fileName} pages=${doc.numPages} loadMs=${ms}`);
  await extractText(result, doc);
}

/** 전 페이지 텍스트 항목을 모아 메인에 저장한다. 품질 판정으로 중단되면 상태 줄에 알린다. */
async function extractText(result: OpenedPdf, doc: PDFDocumentProxy): Promise<void> {
  const t0 = performance.now();
  const collected = await collectTextItems(doc, (done, total) =>
    setStatus(`텍스트 추출 중… ${done}/${total}쪽`),
  );
  const saved = await window.paperlens.saveTextItems({
    pdfSha256: result.pdfSha256,
    pdfjsVersion: PDFJS_VERSION,
    textExtractorVersion: TEXT_EXTRACTOR_VERSION,
    ...collected,
  });
  const ms = Math.round(performance.now() - t0);
  const p0 = saved.pages[0];
  console.info(
    `[paperlens] extracted items=${saved.itemCount} pages=${saved.pages.length} quality=${saved.textQuality} halted=${saved.halted} rev=${saved.extractionRevision} extractMs=${ms}`,
  );
  if (p0) {
    console.info(
      `[paperlens] page0 view=${JSON.stringify(p0.cropBox)} rot=${p0.rotation} size=${p0.width}x${p0.height} quality=${p0.textQuality}`,
    );
  }
  if (saved.halted) {
    setStatus(
      saved.textQuality === 'needs_ocr'
        ? '이 PDF에는 선택할 수 있는 텍스트가 거의 없습니다(스캔본으로 보임). OCR은 지원하지 않아 번역을 진행하지 않습니다.'
        : '이 PDF의 텍스트가 심하게 깨져 있어(글꼴 인코딩 문제) 번역을 진행하지 않습니다.',
    );
    return;
  }
  setStatus(`텍스트 추출 완료 (${saved.itemCount}개 항목, ${ms}ms). GROBID 확인 중…`);
  const health = await window.paperlens.checkParser();
  console.info(`[paperlens] grobid ${JSON.stringify(health)}`);
  if (!health.ok) {
    setStatus(`텍스트 추출 완료. ${health.guidance}`);
    return;
  }
  setStatus(`GROBID ${health.version ?? '?'} 연결됨 · 구조 분석 중… (문서에 따라 수십 초)`);
  const parsed = await window.paperlens.runParser(result.pdfSha256);
  console.info(
    `[paperlens] grobid fulltext bytes=${parsed.byteLength} sentenceCoords=${parsed.hasSentenceCoords} configHash=${parsed.parserConfigHash} ms=${parsed.elapsedMs}`,
  );
  if (!parsed.hasSentenceCoords) {
    setStatus(`구조 분석 완료. 그러나 문장 좌표(<s coords>)가 없어 위치 매핑을 할 수 없습니다.`);
  }
  setStatus(`구조 분석 완료 (${Math.round(parsed.elapsedMs / 1000)}s). 문장 위치를 잇는 중…`);
  const mapped = await window.paperlens.buildDocument(result.pdfSha256);
  console.info(
    `[paperlens] document rev=${mapped.extractionRevision} sentences=${mapped.sentenceCount} mapped=${mapped.mapped} uncertain=${mapped.uncertain} unmapped=${mapped.unmapped} equations=${mapped.equationCount} readingOrder=${mapped.readingOrderMismatches} warnings=${JSON.stringify(mapped.warnings)} ms=${mapped.elapsedMs}`,
  );
  await loadSentenceIndex(result.pdfSha256);
  setStatus(
    `문장 ${mapped.sentenceCount}개 준비 (연결 ${mapped.mapped}, 불확실 ${mapped.uncertain}, 미연결 ${mapped.unmapped}, 수식 ${mapped.equationCount}). 문장을 클릭하거나 드래그하세요.`,
  );
}

/** 확정된 document.json의 문장 색인을 받아 선택 해석기에 넣는다(C1.15). */
async function loadSentenceIndex(pdfSha256: string): Promise<void> {
  const t0 = performance.now();
  const index = await window.paperlens.readDocument(pdfSha256);
  selection.setIndex(index);
  const spans = index.sentences.reduce((n, s) => n + s.sourceSpans.length, 0);
  console.info(
    `[paperlens] sentence index rev=${index.extractionRevision} sentences=${index.sentences.length} spans=${spans} excluded=${index.excludedBlocks.length} ms=${Math.round(performance.now() - t0)}`,
  );
}

/** 선택 해석 결과를 상태 줄과 로그에 남긴다. 우측 패널 표시는 C1.16. */
function onSelection(ev: SelectionEvent): void {
  const ids = ev.result.sentences.map((s) => s.id);
  console.info(
    `[paperlens] selection kind=${ev.kind} reason=${ev.result.reason} byRect=${ev.result.byRect} ranges=${JSON.stringify(ev.ranges.map((r) => [r.textItemId, r.start, r.end]))} sentences=${JSON.stringify(ids)} ms=${ev.elapsedMs.toFixed(1)}`,
  );
  if (ev.result.reason === 'empty_selection') return;
  if (ev.result.sentences.length === 0) {
    setStatus(
      ev.result.reason === 'whitespace_only'
        ? '공백만 선택했습니다.'
        : ev.result.reason === 'excluded_block'
          ? '본문 문장이 아닌 영역(수식·표·머리글 등)입니다.'
          : '이 위치에서 문장을 찾지 못했습니다.',
    );
    return;
  }
  const first = ev.result.sentences[0]!;
  const more = ev.result.sentences.length > 1 ? ` 외 ${ev.result.sentences.length - 1}개` : '';
  setStatus(
    `선택: ${first.id}${more} (${first.mappingStatus}${ev.result.byRect ? ', 위치로 찾음' : ''}) · ${first.en.slice(0, 80)}`,
  );
}

function updateZoomLabel(): void {
  zoomLabel.textContent = `${Math.round(viewer.currentScale * 100)}%`;
}

async function boot(): Promise<void> {
  const info = await window.paperlens.getAppInfo();
  setStatus(
    `PaperLens ${info.appVersion} · Electron ${info.electronVersion} · PDF.js ${PDFJS_VERSION}`,
  );
  $('btn-open').addEventListener('click', () => void openPdf().catch(showError));
  $('btn-zoom-in').addEventListener(
    'click',
    () =>
      void viewer
        .setScale(viewer.currentScale + 0.25)
        .then(updateZoomLabel)
        .catch(showError),
  );
  $('btn-zoom-out').addEventListener(
    'click',
    () =>
      void viewer
        .setScale(viewer.currentScale - 0.25)
        .then(updateZoomLabel)
        .catch(showError),
  );
  updateZoomLabel();
  selection.addListener(onSelection);
  viewer.addPageRenderedListener((pageIndex) => {
    const tl = viewer.textLayerOf(pageIndex);
    if (info.screenshotMode && pageIndex === 0 && tl && tl.textDivs.length > 12) {
      // 스크린샷 검증용(PAPERLENS_SCREENSHOT): 첫 페이지 텍스트 일부를 선택해 텍스트 레이어 정렬을 캡처로 확인한다.
      const range = document.createRange();
      range.setStartBefore(tl.textDivs[6]!);
      range.setEndAfter(tl.textDivs[11]!);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      // 선택 → 항목 범위 변환을 검증 로그로 남긴다(문장 색인이 있으면 해석까지).
      const ranges = rangesFromSelection(window.getSelection(), viewerEl);
      console.info(
        `[paperlens] screenshot selection ranges=${JSON.stringify(ranges.map((r) => [r.textItemId, r.start, r.end, r.text]))}`,
      );
      if (selection.hasIndex) selection.handle();
    }
    console.info(
      `[paperlens] rendered page ${pageIndex} textDivs=${tl?.textDivs.length ?? 0} items=${tl?.textContentItemsStr.length ?? 0}`,
    );
  });
  if (info.autoOpened) await loadOpened(info.autoOpened);
}

function showError(err: unknown): void {
  setStatus(`오류: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
}

void boot().catch(showError);
