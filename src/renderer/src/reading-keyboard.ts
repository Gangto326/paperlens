const EDITING =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="separator"], [role="tablist"]';

/** 닫힌 개념만 순서대로 펼친다. 모두 열면 기본 Tab 이동으로 빠져나갈 수 있다. */
export function openNextConcept(root: HTMLElement): boolean {
  const card = [...root.querySelectorAll<HTMLDetailsElement>('details.concept:not([open])')].find(
    (element) => element.checkVisibility(),
  );
  const summary = card?.querySelector<HTMLElement>('summary');
  if (!summary) return false;
  summary.click();
  summary.focus({ preventScroll: true });
  if (!root.closest('#panel-content')) summary.scrollIntoView({ block: 'nearest' });
  return true;
}

export function setupReadingKeyboard(panel: HTMLElement): void {
  document.addEventListener('keydown', (event) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      document.querySelector('dialog[open], :popover-open')
    )
      return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(EDITING)) return;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      // 즉시 이동하면 키를 길게 눌렀을 때 스크롤 애니메이션이 쌓이지 않는다.
      panel.scrollBy({ top: event.key === 'ArrowDown' ? 80 : -80, behavior: 'instant' });
    } else if (event.key === 'Tab') {
      // 상단 버튼과 링크 등에서는 일반 포커스 이동을 보존한다.
      if (target?.closest('a, button') && !target.closest('.sentence-navigation')) return;
      const reading =
        target === document.body ||
        target?.closest('#viewer, #panel-content, .sentence-navigation');
      if (!reading || document.getElementById('sentence-pane')!.hidden) return;
      if (openNextConcept(document.getElementById('selection')!)) event.preventDefault();
    }
  });
}
