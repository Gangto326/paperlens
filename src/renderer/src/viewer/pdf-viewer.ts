import { pdfjs, type PDFDocumentProxy, type PDFPageProxy } from './pdfjs';

export interface PdfViewerOptions {
  container: HTMLElement;
  /** 화면 밖 페이지를 미리 렌더링할 여유 (뷰포트 높이 배수) */
  prerenderMargin?: number;
}

interface PageSlot {
  pageIndex: number;
  element: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  textLayerDiv: HTMLDivElement | null;
  textLayer: pdfjs.TextLayer | null;
  rendered: boolean;
  rendering: Promise<void> | null;
  renderTask: pdfjs.RenderTask | null;
  page: PDFPageProxy | null;
}

/**
 * 페이지를 지연 렌더링하는 최소 PDF 뷰어.
 * - 모든 페이지 자리를 먼저 만들어 스크롤 높이를 확보하고, 보이는 페이지만 캔버스에 그린다.
 * - 확대율을 바꾸면 자리 크기를 다시 계산하고 보이는 페이지부터 다시 그린다.
 */
export class PdfViewer {
  private doc: PDFDocumentProxy | null = null;
  private loadingTask: pdfjs.PDFDocumentLoadingTask | null = null;
  private slots: PageSlot[] = [];
  private scale = 1.25;
  private observer: IntersectionObserver;
  private readonly container: HTMLElement;
  private readonly onPageRendered = new Set<(pageIndex: number, slot: HTMLDivElement) => void>();

  constructor(private readonly opts: PdfViewerOptions) {
    this.container = opts.container;
    this.observer = this.createObserver();
  }

  get document(): PDFDocumentProxy | null {
    return this.doc;
  }

  get currentScale(): number {
    return this.scale;
  }

  addPageRenderedListener(fn: (pageIndex: number, slot: HTMLDivElement) => void): void {
    this.onPageRendered.add(fn);
  }

  async load(bytes: Uint8Array): Promise<PDFDocumentProxy> {
    await this.close();
    const task = pdfjs.getDocument({ data: bytes });
    this.loadingTask = task;
    const doc = await task.promise;
    this.doc = doc;
    this.container.replaceChildren();
    // pdf_viewer.css의 .textLayer는 --scale-factor(뷰어)·--user-unit(페이지)로 글자 크기를 계산한다.
    this.container.classList.add('pdfViewer');
    this.container.style.setProperty('--scale-factor', String(this.scale));
    this.slots = [];
    for (let i = 0; i < doc.numPages; i++) {
      const element = document.createElement('div');
      element.className = 'pdf-page page';
      element.dataset['pageIndex'] = String(i);
      this.container.append(element);
      this.slots.push({
        pageIndex: i,
        element,
        canvas: null,
        textLayerDiv: null,
        textLayer: null,
        rendered: false,
        rendering: null,
        renderTask: null,
        page: null,
      });
    }
    await this.layout();
    return doc;
  }

  async close(): Promise<void> {
    this.observer.disconnect();
    for (const s of this.slots) s.renderTask?.cancel();
    this.slots = [];
    this.container.replaceChildren();
    if (this.loadingTask) await this.loadingTask.destroy();
    this.loadingTask = null;
    this.doc = null;
    this.observer = this.createObserver();
  }

  async setScale(scale: number): Promise<void> {
    this.scale = Math.min(4, Math.max(0.5, scale));
    this.container.style.setProperty('--scale-factor', String(this.scale));
    for (const s of this.slots) {
      s.renderTask?.cancel();
      s.renderTask = null;
      s.rendered = false;
      s.rendering = null;
      s.textLayer?.cancel();
      s.textLayer = null;
      s.textLayerDiv?.remove();
      s.textLayerDiv = null;
    }
    await this.layout();
  }

  pageElement(pageIndex: number): HTMLDivElement | undefined {
    return this.slots[pageIndex]?.element;
  }

  /** 렌더된 페이지의 TextLayer. textDivs·textContentItemsStr로 DOM↔텍스트 항목을 잇는다(C1.15). */
  textLayerOf(pageIndex: number): pdfjs.TextLayer | null {
    return this.slots[pageIndex]?.textLayer ?? null;
  }

  pageProxyOf(pageIndex: number): PDFPageProxy | null {
    return this.slots[pageIndex]?.page ?? null;
  }

  /** 페이지 크기를 확대율에 맞춰 자리 크기를 정하고 관찰을 다시 등록한다. */
  private async layout(): Promise<void> {
    if (!this.doc) return;
    this.observer.disconnect();
    for (const slot of this.slots) {
      slot.page ??= await this.doc.getPage(slot.pageIndex + 1);
      const viewport = slot.page.getViewport({ scale: this.scale });
      slot.element.style.width = `${Math.floor(viewport.width)}px`;
      slot.element.style.height = `${Math.floor(viewport.height)}px`;
      slot.element.style.setProperty('--user-unit', String(slot.page.userUnit));
      this.observer.observe(slot.element);
    }
  }

  private createObserver(): IntersectionObserver {
    const margin = this.opts.prerenderMargin ?? 1;
    return new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const idx = Number((entry.target as HTMLElement).dataset['pageIndex']);
          const slot = this.slots[idx];
          if (!slot) continue;
          if (entry.isIntersecting) void this.renderSlot(slot);
        }
      },
      { root: this.container, rootMargin: `${margin * 100}% 0px` },
    );
  }

  private async renderSlot(slot: PageSlot): Promise<void> {
    if (slot.rendered || slot.rendering || !slot.page) return;
    const page = slot.page;
    const viewport = page.getViewport({ scale: this.scale });
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const task = page.render({
      canvas,
      canvasContext: ctx,
      viewport,
      transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
    });
    slot.renderTask = task;
    slot.rendering = task.promise
      .then(async () => {
        slot.canvas?.remove();
        slot.canvas = canvas;
        slot.element.prepend(canvas);
        await this.renderTextLayer(slot, viewport);
        slot.rendered = true;
        for (const fn of this.onPageRendered) fn(slot.pageIndex, slot.element);
      })
      .catch((err: unknown) => {
        if (!(err instanceof pdfjs.RenderingCancelledException)) throw err;
      })
      .finally(() => {
        slot.rendering = null;
        slot.renderTask = null;
      });
    await slot.rendering;
  }

  /** 캔버스 위에 선택 가능한 텍스트 레이어를 만든다. 항목 하나 = span 하나를 가정하지 않는다. */
  private async renderTextLayer(slot: PageSlot, viewport: pdfjs.PageViewport): Promise<void> {
    if (!slot.page) return;
    slot.textLayer?.cancel();
    slot.textLayerDiv?.remove();
    const div = document.createElement('div');
    div.className = 'textLayer';
    pdfjs.setLayerDimensions(div, viewport);
    slot.element.append(div);
    const textContent = await slot.page.getTextContent();
    const layer = new pdfjs.TextLayer({ textContentSource: textContent, container: div, viewport });
    slot.textLayerDiv = div;
    slot.textLayer = layer;
    await layer.render();
  }
}
