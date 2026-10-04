import {
  SentenceLookup,
  type SelectionResult,
  type SentenceIndex,
  type TextRange,
} from '@shared/mapping/selection';
import { caretFromPoint, rangesFromSelection, textRangeAtCaret } from './dom-selection';
import type { PdfViewer } from './pdf-viewer';

export interface SelectionEvent {
  result: SelectionResult;
  /** 해석에 쓴 항목 범위(디버그·검증용) */
  ranges: TextRange[];
  /** 'drag' = 비어 있지 않은 Selection, 'click' = caret/지점 */
  kind: 'drag' | 'click' | 'keyboard';
  elapsedMs: number;
}

/**
 * 뷰어의 mouseup을 문장 선택으로 해석한다(C1.15). 드래그면 Selection의 범위로, 클릭이면 클릭 지점의 caret으로,
 * caret이 어느 스팬에도 없으면 지점의 user space 좌표로 문장 사각형을 찾는다(미연결 문장·제외 블록 구분).
 * 문장 색인이 없으면(document.json 미확정) 아무것도 해석하지 않는다.
 */
export class SelectionController {
  private lookup: SentenceLookup | null = null;
  private readonly listeners = new Set<(ev: SelectionEvent) => void>();

  constructor(
    private readonly viewer: PdfViewer,
    private readonly root: HTMLElement,
  ) {
    root.addEventListener('mouseup', (ev) => {
      if (ev.button !== 0) return;
      // Selection은 mouseup 처리 뒤에 확정되므로 한 틱 미룬다.
      setTimeout(() => this.handle(ev.clientX, ev.clientY), 0);
    });
  }

  setIndex(index: SentenceIndex | null): void {
    this.lookup = index ? new SentenceLookup(index) : null;
  }

  get hasIndex(): boolean {
    return this.lookup !== null;
  }

  addListener(fn: (ev: SelectionEvent) => void): void {
    this.listeners.add(fn);
  }

  /** 현재 Selection(또는 지점)을 해석한다. 검증 모드에서 프로그램이 만든 선택도 이 경로로 해석한다. */
  handle(clientX?: number, clientY?: number): SelectionEvent | null {
    const lookup = this.lookup;
    if (!lookup) return null;
    const t0 = performance.now();
    const ranges = rangesFromSelection(window.getSelection(), this.root);
    const dragged = ranges.some((r) => r.end > r.start);
    let result: SelectionResult;
    let kind: SelectionEvent['kind'] = 'drag';
    if (dragged) {
      result = lookup.resolveRanges(ranges);
    } else {
      kind = 'click';
      if (clientX === undefined || clientY === undefined) {
        result = lookup.resolveRanges(ranges);
      } else {
        const pageIndex = this.viewer.pageIndexAt(clientX, clientY);
        const point =
          pageIndex === null ? null : this.viewer.userSpacePointAt(pageIndex, clientX, clientY);
        const caret = caretFromPoint(clientX, clientY);
        const caretRange = caret ? textRangeAtCaret(caret.node, caret.offset, this.root) : null;
        if (caretRange) {
          ranges.splice(0, ranges.length, caretRange);
          result = lookup.resolveCaret(
            { textItemId: caretRange.textItemId, offset: caretRange.start },
            point,
          );
        } else if (point) {
          result = lookup.resolvePoint(point);
        } else {
          result = { sentences: [], reason: 'empty_selection', byRect: false };
        }
      }
    }
    const ev: SelectionEvent = { result, ranges, kind, elapsedMs: performance.now() - t0 };
    for (const fn of this.listeners) fn(ev);
    return ev;
  }
}
