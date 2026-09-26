import type { OpenedPdf } from '@shared/ipc';
import { PdfViewer } from './viewer/pdf-viewer';
import { PDFJS_VERSION } from './viewer/pdfjs';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} 없음`);
  return el as T;
};

const statusEl = $('status');
const titleEl = $('doc-title');
const zoomLabel = $('zoom-label');
const viewer = new PdfViewer({ container: $('viewer') });

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
  const t0 = performance.now();
  const bytes = await window.paperlens.readPdfBytes(result.pdfSha256);
  const doc = await viewer.load(bytes);
  titleEl.textContent = `${result.fileName} · ${doc.numPages}쪽 · ${result.pdfSha256.slice(0, 12)}…`;
  const ms = Math.round(performance.now() - t0);
  setStatus(`열림 (${ms}ms). 문장을 클릭하거나 드래그하세요.`);
  console.info(`[paperlens] loaded ${result.fileName} pages=${doc.numPages} loadMs=${ms}`);
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
  viewer.addPageRenderedListener((pageIndex) =>
    console.info(`[paperlens] rendered page ${pageIndex}`),
  );
  if (info.autoOpened) await loadOpened(info.autoOpened);
}

function showError(err: unknown): void {
  setStatus(`오류: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
}

void boot().catch(showError);
