import type { TextRange } from '@shared/mapping/selection';

/**
 * DOM Selection/Range → 텍스트 항목 문자 범위(C1.15, PLAN 5.6 4~5).
 *
 * 텍스트 레이어의 span에는 pdf-viewer가 `data-item-id`(= TextItemRecord.id)를 새긴다. 이 모듈은 선택에 걸린 텍스트 노드마다
 * 가장 가까운 `[data-item-id]` 조상을 찾아 항목 ID로 옮기고, 노드 안 offset을 항목 `str`의 utf16 offset으로 쓴다
 * (TextLayer는 span.textContent = str 이라 텍스트 노드 하나 = str 전체). span 안에 텍스트 노드가 여러 개이거나
 * 항목이 여러 span으로 나뉘어도 노드별로 처리하므로 "항목 하나 = span 하나"를 가정하지 않는다 — 단, 노드가 str의 앞부분이
 * 아닌 경우의 offset 보정은 노드 앞 형제 텍스트 길이를 더해 계산한다.
 */

const ITEM_SELECTOR = '[data-item-id]';

function itemElementOf(node: Node): HTMLElement | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return el?.closest<HTMLElement>(ITEM_SELECTOR) ?? null;
}

/** 텍스트 노드가 항목 span 안에서 시작하는 utf16 offset(앞 형제 텍스트 길이의 합). */
function nodeBase(node: Text, item: HTMLElement): number {
  let base = 0;
  const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n === node) return base;
    base += (n as Text).length;
  }
  return base;
}

/** Selection의 모든 Range를 항목 범위로 옮긴다. root 밖(패널 등)의 노드는 무시한다. 문서 순서. */
export function rangesFromSelection(sel: Selection | null, root: HTMLElement): TextRange[] {
  const out: TextRange[] = [];
  if (!sel) return out;
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    if (range.collapsed) {
      const caret = textRangeAtCaret(range.startContainer, range.startOffset, root);
      if (caret) out.push(caret);
      continue;
    }
    const common = range.commonAncestorContainer;
    const nodes: Text[] = [];
    if (common.nodeType === Node.TEXT_NODE) nodes.push(common as Text);
    else {
      const walker = document.createTreeWalker(common, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (range.intersectsNode(n)) nodes.push(n as Text);
      }
    }
    for (const node of nodes) {
      const item = itemElementOf(node);
      if (!item || !root.contains(item)) continue;
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.length;
      if (end <= start) continue;
      const base = nodeBase(node, item);
      out.push({
        textItemId: item.dataset['itemId']!,
        start: base + start,
        end: base + end,
        text: node.data.slice(start, end),
      });
    }
  }
  return out;
}

/** caret(노드·offset) → 항목 범위(start === end). 텍스트 레이어 밖이면 null. */
export function textRangeAtCaret(node: Node, offset: number, root: HTMLElement): TextRange | null {
  const item = itemElementOf(node);
  if (!item || !root.contains(item)) return null;
  let base: number;
  if (node.nodeType === Node.TEXT_NODE) base = nodeBase(node as Text, item) + offset;
  else if (node !== item) return null;
  else {
    // 요소 자체가 컨테이너인 caret: offset은 자식 index. 자식 앞까지의 텍스트 길이로 바꾼다.
    base = 0;
    for (let k = 0; k < Math.min(offset, item.childNodes.length); k++) {
      base += item.childNodes[k]!.textContent?.length ?? 0;
    }
  }
  return { textItemId: item.dataset['itemId']!, start: base, end: base, text: '' };
}

/** 화면 좌표의 caret. Chromium의 caretPositionFromPoint(표준) 또는 caretRangeFromPoint(구식)를 쓴다. */
export function caretFromPoint(
  clientX: number,
  clientY: number,
): { node: Node; offset: number } | null {
  const d = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (typeof d.caretPositionFromPoint === 'function') {
    const p = d.caretPositionFromPoint(clientX, clientY);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  if (typeof d.caretRangeFromPoint === 'function') {
    const r = d.caretRangeFromPoint(clientX, clientY);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  return null;
}
