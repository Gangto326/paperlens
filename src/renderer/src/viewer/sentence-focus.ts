import { pageBoxOf, userSpaceToViewport } from '@shared/geometry/coords';
import type { SelectionResult, SentenceIndex, SentenceIndexEntry } from '@shared/mapping/selection';
import type { PdfViewer } from './pdf-viewer';
import { adjacentSentenceId } from './sentence-navigation';

/** 패널과 같은 선택 상태로 원문 표시와 키보드 탐색을 구동한다. 저장 데이터는 바꾸지 않는다. */
export class SentenceFocus {
  private index: SentenceIndex | null = null;
  private selected: SentenceIndexEntry[] = [];
  private readonly previous = document.querySelector<HTMLButtonElement>('#btn-sentence-prev')!;
  private readonly next = document.querySelector<HTMLButtonElement>('#btn-sentence-next')!;
  private readonly position = document.querySelector<HTMLElement>('#sentence-position')!;

  constructor(
    private readonly viewer: PdfViewer,
    private readonly container: HTMLElement,
    private readonly onNavigate: (result: SelectionResult) => void,
  ) {
    viewer.addPageRenderedListener((page) => this.paintPage(page));
    viewer.addLayoutListener(() => this.paint());
    this.previous.addEventListener('click', () => this.move(-1));
    this.next.addEventListener('click', () => this.move(1));
    document.addEventListener('keydown', (event) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      // 입력·탭·크기 조절·팝오버의 기본 키보드 조작을 침범하지 않는다.
      const target = event.target instanceof Element ? event.target : null;
      if (
        target?.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="tablist"], [role="separator"], [role="slider"]',
        )
      )
        return;
      if (document.querySelector(':popover-open, dialog[open]')) return;
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      if (!this.adjacent(direction)) return;
      event.preventDefault();
      this.move(direction);
    });
  }

  setIndex(index: SentenceIndex | null): void {
    this.index = index
      ? { ...index, sentences: [...index.sentences].sort((a, b) => a.order - b.order) }
      : null;
    this.selected = [];
    this.paint();
    this.updateControls();
  }

  setSelection(result: SelectionResult): void {
    if (result.reason === 'empty_selection') return;
    this.selected = result.sentences;
    this.paint();
    this.updateControls();
  }

  private adjacent(direction: -1 | 1): SentenceIndexEntry | null {
    const sentences = this.index?.sentences ?? [];
    const id = adjacentSentenceId(
      sentences.map((s) => s.id),
      this.selected.map((s) => s.id),
      direction,
    );
    return sentences.find((s) => s.id === id) ?? null;
  }

  private move(direction: -1 | 1): void {
    const sentence = this.adjacent(direction);
    if (!sentence) return;
    this.navigateTo(sentence.id);
  }

  navigateTo(id: string): void {
    const sentence = this.index?.sentences.find((entry) => entry.id === id);
    if (!sentence) return;
    window.getSelection()?.removeAllRanges();
    this.onNavigate({ sentences: [sentence], reason: 'ok', byRect: false });
    this.reveal(sentence);
  }

  private updateControls(): void {
    this.previous.disabled = !this.adjacent(-1);
    this.next.disabled = !this.adjacent(1);
    const sentences = this.index?.sentences ?? [];
    if (!this.selected.length) {
      this.position.textContent = sentences.length
        ? '문장을 선택하거나 →로 시작'
        : '문장을 선택해 읽기';
      return;
    }
    const positions = this.selected
      .map((s) => sentences.findIndex((entry) => entry.id === s.id) + 1)
      .sort((a, b) => a - b);
    const range =
      positions.length === 1 ? String(positions[0]) : `${positions[0]}–${positions.at(-1)}`;
    this.position.textContent = `${range} / ${sentences.length} 문장`;
  }

  private paint(): void {
    this.container.querySelectorAll('.sentence-highlight-layer').forEach((layer) => layer.remove());
    const pages = new Set(this.selected.flatMap((s) => s.rects.map((r) => r.pageIndex)));
    for (const page of pages) this.paintPage(page);
  }

  private paintPage(pageIndex: number): void {
    const element = this.viewer.pageElement(pageIndex);
    element?.querySelector('.sentence-highlight-layer')?.remove();
    const page = this.index?.pages.find((p) => p.pageIndex === pageIndex);
    if (!element || !page) return;
    const layer = document.createElement('div');
    layer.className = 'sentence-highlight-layer';
    layer.setAttribute('aria-hidden', 'true');
    for (const sentence of this.selected) {
      for (const rect of sentence.rects.filter((r) => r.pageIndex === pageIndex)) {
        const box = userSpaceToViewport(rect, pageBoxOf(page), this.viewer.currentScale);
        const mark = document.createElement('span');
        mark.className = 'sentence-highlight';
        mark.dataset['sentenceId'] = sentence.id;
        Object.assign(mark.style, {
          left: `${box.x}px`,
          top: `${box.y}px`,
          width: `${box.width}px`,
          height: `${box.height}px`,
        });
        layer.append(mark);
      }
    }
    if (layer.childElementCount) element.append(layer);
  }

  private reveal(sentence: SentenceIndexEntry): void {
    const rect = sentence.rects[0];
    const pageIndex = rect?.pageIndex ?? sentence.page;
    const element = this.viewer.pageElement(pageIndex);
    const page = this.index?.pages.find((p) => p.pageIndex === pageIndex);
    if (!element || !page) return;
    const box = rect
      ? userSpaceToViewport(rect, pageBoxOf(page), this.viewer.currentScale)
      : { x: 0, y: 0, width: 0, height: 0 };
    const bounds = this.container.getBoundingClientRect();
    const pageBounds = element.getBoundingClientRect();
    const top = pageBounds.top + box.y;
    const left = pageBounds.left + box.x;
    // 화면 안에 있으면 읽던 위치를 유지한다. 넘어갈 때만 해당 문장이 보이도록 이동한다.
    if (top < bounds.top + 24 || top + box.height > bounds.bottom - 24) {
      this.container.scrollTop += top - bounds.top - this.container.clientHeight * 0.25;
    }
    if (left < bounds.left + 16 || left + box.width > bounds.right - 16) {
      this.container.scrollLeft += left - bounds.left - 24;
    }
  }
}
