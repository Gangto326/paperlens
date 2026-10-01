import 'pdfjs-dist/web/pdf_viewer.css';
import type { OpenedPdf, ProcessEvent, SentenceIndex, TranslationSnapshot } from '@shared/ipc';
import { collectTextItems, TEXT_EXTRACTOR_VERSION } from './extract/text-items';
import { AccountPanel } from './panel/account-panel';
import { ChecksPanel } from './panel/checks-panel';
import {
  INITIAL_PROCESS,
  applyProcessEvent,
  processFromSnapshot,
  processView,
  type ProcessModel,
} from './panel/process-view';
import { OverviewPanel } from './panel/overview-panel';
import { lookupOf } from './panel/selection-view';
import { SentencePanel } from './panel/sentence-panel';
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
const stageEl = $('stage');
const titleEl = $('doc-title');
const zoomLabel = $('zoom-label');
const viewerEl = $('viewer');
const viewer = new PdfViewer({ container: viewerEl });
const selection = new SelectionController(viewer, viewerEl);
const panel = new SentencePanel($('selection'));
const overviewPanel = new OverviewPanel($('overview'));
const accountPanel = new AccountPanel($('account'), (err) => showError(err));
const checksPanel = new ChecksPanel($('checks'), {
  login: async () => {
    const start = await window.paperlens.startLogin();
    if (!start.started) throw new Error(`로그인을 시작하지 못했습니다: ${start.reason}`);
  },
  onError: (err) => showError(err),
});
const processButton = $<HTMLButtonElement>('btn-process');
let screenshotMode = false;
/** 열려 있는 논문. 다른 논문의 처리 이벤트는 화면에 반영하지 않는다. */
let currentSha: string | null = null;
let processModel: ProcessModel = INITIAL_PROCESS;
let translations: TranslationSnapshot | null = null;

/** 상단 단계 표시(PLAN 9: 추출 → 문장 연결 → 논문 문맥·조사 → 번역 → 완료). 진행률은 실제 완료 수만 쓴다. */
function setStage(text: string): void {
  stageEl.textContent = text;
}

function setStatus(text: string): void {
  statusEl.textContent = text;
}

/** 처리 단계 글과 시작·멈춤 단추를 모델대로 그린다(C2.9). */
function renderProcess(): void {
  const view = processView(processModel);
  if (view.stage !== '') setStage(view.stage);
  processButton.hidden = view.button === null;
  if (view.button) {
    processButton.textContent = view.button.label;
    processButton.disabled = view.button.disabled;
    processButton.dataset['action'] = view.button.action;
  }
}

/** 저장된 번역을 캐시에서 읽어 메모리에 둔다. 선택 표시는 이 값만 조회한다. */
async function loadTranslations(pdfSha256: string, fresh: boolean): Promise<void> {
  const t0 = performance.now();
  const snapshot = await window.paperlens.readTranslations(pdfSha256);
  if (currentSha !== pdfSha256) return;
  translations = snapshot;
  panel.setTranslations(lookupOf(snapshot));
  overviewPanel.set(snapshot);
  if (fresh) processModel = processFromSnapshot(snapshot);
  renderProcess();
  console.info(
    `[paperlens] translations state=${snapshot.state} generation=${String(snapshot.generationId)} chunks=${snapshot.chunks.map((c) => c.status[0]).join('')} sentences=${Object.keys(snapshot.results).length} ms=${Math.round(performance.now() - t0)}`,
  );
}

function onProcessEvent(event: ProcessEvent): void {
  if (event.pdfSha256 !== currentSha) return;
  processModel = applyProcessEvent(processModel, event);
  renderProcess();
  // 1차 패스가 끝나면 개요·용어집을 바로 보여 준다(C3.7).
  if (
    event.type === 'chunkFinished' ||
    event.type === 'finished' ||
    (event.type === 'context' && (event.status === 'done' || event.status === 'reused')) ||
    (event.type === 'research' && event.status === 'done')
  ) {
    console.info(`[paperlens] process ${JSON.stringify({ ...event, sentenceIds: undefined })}`);
    void loadTranslations(event.pdfSha256, false).catch(showError);
  }
  if (event.type === 'finished' && event.message) setStatus(event.message);
}

async function onProcessButton(): Promise<void> {
  if (!currentSha) return;
  if (processButton.dataset['action'] === 'stop') {
    const stopped = await window.paperlens.stopProcessing();
    if (stopped.accepted) processModel = { ...processModel, stopRequested: true };
    renderProcess();
    return;
  }
  const started = await window.paperlens.startProcessing(currentSha);
  if (!started.started) {
    setStatus(`번역을 시작하지 못했습니다: ${started.reason ?? '알 수 없는 이유'}`);
    return;
  }
  processModel = { ...processModel, running: true, phase: 'context', message: null };
  renderProcess();
  setStatus('번역을 시작했습니다. 끝난 부분부터 표시됩니다.');
}

async function openPdf(): Promise<void> {
  const result = await window.paperlens.openPdfDialog();
  if (result.canceled) return;
  await loadOpened(result);
}

async function loadOpened(result: OpenedPdf): Promise<void> {
  setStatus(`읽는 중… ${result.fileName}`);
  setStage('열는 중');
  selection.setIndex(null);
  panel.clear();
  currentSha = result.pdfSha256;
  translations = null;
  processModel = INITIAL_PROCESS;
  panel.setTranslations(lookupOf(null));
  overviewPanel.set(null);
  processButton.hidden = true;
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
  setStage('추출');
  const collected = await collectTextItems(doc, (done, total) => {
    setStatus(`텍스트 추출 중… ${done}/${total}쪽`);
    setStage(`추출 ${done}/${total}쪽`);
  });
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
    setStage('중단');
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
    // 같은 rev의 document.json이 이미 캐시에 있으면(이전 실행에서 연결 완료) GROBID 없이 그것으로 선택·표시한다.
    const reused = await loadSentenceIndex(result.pdfSha256).catch((err: unknown) => {
      console.info(
        `[paperlens] no cached document: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    });
    if (reused) {
      renderProcess();
      setStatus(
        `텍스트 추출 완료. GROBID에 연결할 수 없지만 이전에 연결한 문장 ${reused.sentences.length}개(캐시)를 사용합니다. 문장을 클릭하거나 드래그하세요.`,
      );
      return;
    }
    setStage('문장 연결 대기 (GROBID 없음)');
    setStatus(`텍스트 추출 완료. ${health.guidance}`);
    return;
  }
  setStage('구조 분석');
  setStatus(`GROBID ${health.version ?? '?'} 연결됨 · 구조 분석 중… (문서에 따라 수십 초)`);
  const parsed = await window.paperlens.runParser(result.pdfSha256);
  console.info(
    `[paperlens] grobid fulltext bytes=${parsed.byteLength} sentenceCoords=${parsed.hasSentenceCoords} configHash=${parsed.parserConfigHash} ms=${parsed.elapsedMs}`,
  );
  if (!parsed.hasSentenceCoords) {
    setStatus(`구조 분석 완료. 그러나 문장 좌표(<s coords>)가 없어 위치 매핑을 할 수 없습니다.`);
  }
  setStage('문장 연결');
  setStatus(`구조 분석 완료 (${Math.round(parsed.elapsedMs / 1000)}s). 문장 위치를 잇는 중…`);
  const mapped = await window.paperlens.buildDocument(result.pdfSha256);
  console.info(
    `[paperlens] document rev=${mapped.extractionRevision} sentences=${mapped.sentenceCount} mapped=${mapped.mapped} uncertain=${mapped.uncertain} unmapped=${mapped.unmapped} equations=${mapped.equationCount} readingOrder=${mapped.readingOrderMismatches} warnings=${JSON.stringify(mapped.warnings)} ms=${mapped.elapsedMs}`,
  );
  await loadSentenceIndex(result.pdfSha256);
  renderProcess();
  setStatus(
    `문장 ${mapped.sentenceCount}개 준비 (연결 ${mapped.mapped}, 불확실 ${mapped.uncertain}, 미연결 ${mapped.unmapped}, 수식 ${mapped.equationCount}). 문장을 클릭하거나 드래그하세요.`,
  );
}

/** 확정된 document.json의 문장 색인을 받아 선택 해석기에 넣는다(C1.15). 없으면 throw. */
async function loadSentenceIndex(pdfSha256: string): Promise<SentenceIndex> {
  const t0 = performance.now();
  const index = await window.paperlens.readDocument(pdfSha256);
  selection.setIndex(index);
  const spans = index.sentences.reduce((n, s) => n + s.sourceSpans.length, 0);
  console.info(
    `[paperlens] sentence index rev=${index.extractionRevision} sentences=${index.sentences.length} spans=${spans} excluded=${index.excludedBlocks.length} ms=${Math.round(performance.now() - t0)}`,
  );
  await loadTranslations(pdfSha256, true);
  if (screenshotMode) screenshotSelectSentence(index);
  return index;
}

/**
 * 스크린샷 검증용(PAPERLENS_SCREENSHOT): 첫 페이지에서 스팬이 둘 이상인 첫 mapped 문장을 골라 첫 스팬 2글자 뒤부터
 * 마지막 스팬 2글자 앞까지 부분 드래그하고 해석한다 — 부분 드래그가 전체 문장으로 확장되어 패널에 보이는지 캡처로 본다.
 */
function screenshotSelectSentence(index: SentenceIndex): void {
  const tl = viewer.textLayerOf(0);
  const target = index.sentences.find(
    (s) =>
      s.mappingStatus === 'mapped' &&
      s.sourceSpans.length >= 2 &&
      s.sourceSpans.every((sp) => sp.pageIndex === 0),
  );
  if (!tl || !target) {
    console.info(
      '[paperlens] screenshot: no multi-span sentence on page 0 or text layer not ready',
    );
    return;
  }
  const first = target.sourceSpans[0]!;
  const last = target.sourceSpans[target.sourceSpans.length - 1]!;
  const divOf = (id: string): Node | null =>
    tl.textDivs[Number(id.split('_')[2])]?.firstChild ?? null;
  const a = divOf(first.textItemId);
  const b = divOf(last.textItemId);
  if (!a || !b) return;
  const range = document.createRange();
  range.setStart(a, Math.min(first.utf16Start + 2, first.utf16End));
  range.setEnd(b, Math.max(last.utf16End - 2, last.utf16Start));
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  const ev = selection.handle();
  console.info(
    `[paperlens] screenshot partial drag target=${target.id} spans=${target.sourceSpans.length} → ${JSON.stringify(ev?.result.sentences.map((s) => s.id) ?? null)}`,
  );
  // 캡처에 개념 카드의 내용과 자료 링크가 보이도록 첫 카드를 펼친다.
  const card = document.querySelector<HTMLDetailsElement>('details.concept');
  if (card) card.open = true;
}

/**
 * 선택 해석 결과를 우측 패널에 그리고 로그에 남긴다(C1.16). 표시는 메모리 색인 조회 + DOM 생성뿐이라
 * 네트워크를 기다리지 않는다. PLAN의 목표(선택 후 캐시 표시 200ms 이내)를 매 선택마다 측정해 넘으면 경고 로그.
 */
const PANEL_TARGET_MS = 200;

function onSelection(ev: SelectionEvent): void {
  const t0 = performance.now();
  panel.show(ev.result);
  const renderMs = performance.now() - t0;
  const totalMs = ev.elapsedMs + renderMs;
  const ids = ev.result.sentences.map((s) => s.id);
  const translated = ids.filter((id) => translations?.results[id] !== undefined).length;
  console.info(
    `[paperlens] selection translated=${translated}/${ids.length} kind=${ev.kind} reason=${ev.result.reason} byRect=${ev.result.byRect} ranges=${JSON.stringify(ev.ranges.map((r) => [r.textItemId, r.start, r.end]))} sentences=${JSON.stringify(ids)} resolveMs=${ev.elapsedMs.toFixed(1)} renderMs=${renderMs.toFixed(1)} totalMs=${totalMs.toFixed(1)}`,
  );
  if (totalMs > PANEL_TARGET_MS) {
    console.warn(`[paperlens] selection display ${totalMs.toFixed(0)}ms > ${PANEL_TARGET_MS}ms`);
  }
}

function updateZoomLabel(): void {
  zoomLabel.textContent = `${Math.round(viewer.currentScale * 100)}%`;
}

async function boot(): Promise<void> {
  const info = await window.paperlens.getAppInfo();
  screenshotMode = info.screenshotMode;
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
  processButton.addEventListener('click', () => void onProcessButton().catch(showError));
  window.paperlens.onProcessEvent(onProcessEvent);
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
  // 계정·한도 표시(C1.19). 런타임이 아직 뜨는 중이면 unavailable로 시작하고 main의 푸시로 갱신된다.
  await accountPanel.start();
  // 의존 서비스 점검(C5.1). 런타임과 로그인은 뒤늦게 바뀌므로 계정 이벤트가 오면 다시 본다. 문제가 있을 때만 펼친다.
  void checksPanel.refresh();
  window.paperlens.onAccountEvent((event) => {
    if (event.type === 'account' || event.type === 'loginCompleted')
      void checksPanel.refresh(false);
  });
  if (info.autoOpened) await loadOpened(info.autoOpened);
}

function showError(err: unknown): void {
  setStatus(`오류: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
}

void boot().catch(showError);
