/** native details의 키보드·접근성 동작을 유지하며 사용자가 펼치고 접는 동작만 보간한다. */
export function setupDisclosures(root: HTMLElement): void {
  const running = new WeakMap<HTMLDetailsElement, { animation: Animation; opening: boolean }>();
  let latestOpened: HTMLDetailsElement | null = null;
  const reveal = (card: HTMLDetailsElement): void => {
    if (root.id !== 'panel-content' || latestOpened !== card || !card.isConnected || !card.open)
      return;
    // 마지막 카드도 같은 읽기 위치에 놓일 수 있도록 아래쪽 스크롤 여유를 확보한다.
    root.style.setProperty('--reading-space', `${root.clientHeight * 0.8}px`);
    const panelTop = root.getBoundingClientRect().top;
    const cardTop = card.getBoundingClientRect().top;
    const readingTop = panelTop + root.clientHeight * 0.2;
    if (cardTop > readingTop || cardTop < panelTop) {
      root.scrollBy({
        top: cardTop - readingTop,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
      });
    }
  };
  root.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const summary = target?.closest('summary');
    const details = summary?.parentElement;
    if (!(details instanceof HTMLDetailsElement) || !details.matches('.concept, .explain')) return;
    if (target?.closest('a, button, input')) return;
    event.preventDefault();
    const current = running.get(details);
    const opening = current ? !current.opening : !details.open;
    if (opening && details.matches('.concept')) latestOpened = details;
    const from = details.getBoundingClientRect().height;
    current?.animation.cancel();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      details.open = opening;
      details.style.overflow = '';
      running.delete(details);
      if (opening) reveal(details);
      return;
    }
    details.open = opening;
    const to = details.getBoundingClientRect().height;
    details.open = true;
    details.style.overflow = 'clip';
    const animation = details.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: 260,
      easing: 'cubic-bezier(.2,.8,.2,1)',
    });
    running.set(details, { animation, opening });
    animation.onfinish = () => {
      details.open = opening;
      details.style.overflow = '';
      running.delete(details);
      if (opening) reveal(details);
    };
  });
}
