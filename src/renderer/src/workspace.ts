import type { PdfViewer } from './viewer/pdf-viewer';

const TABS = ['sentence', 'paper', 'work'] as const;
type WorkspaceTab = (typeof TABS)[number];

/** 읽기 도구. PDF 페이지의 크기와 텍스트 레이어는 뷰어만 변경한다. */
export class Workspace {
  private readonly pageInput = document.querySelector<HTMLInputElement>('#page-number')!;
  private readonly panelContent = document.querySelector<HTMLElement>('#panel-content')!;
  private activeTab: WorkspaceTab = 'sentence';
  private readonly scrollPositions = { sentence: 0, paper: 0, work: 0 };
  private scrollQueued = false;

  constructor(
    private readonly viewer: PdfViewer,
    private readonly container: HTMLElement,
    private readonly onZoom: () => void,
    private readonly onError: (error: unknown) => void,
  ) {
    for (const name of TABS) {
      const tab = document.getElementById(`tab-${name}`)!;
      tab.addEventListener('click', () => this.selectTab(name));
      tab.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index = TABS.indexOf(name);
        const next =
          TABS[
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? TABS.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length
          ]!;
        this.selectTab(next);
        document.getElementById(`tab-${next}`)!.focus();
      });
    }
    document
      .getElementById('btn-page-prev')!
      .addEventListener('click', () => this.goTo(Number(this.pageInput.value) - 1));
    document
      .getElementById('btn-page-next')!
      .addEventListener('click', () => this.goTo(Number(this.pageInput.value) + 1));
    this.pageInput.addEventListener('change', () => this.goTo(Number(this.pageInput.value)));
    this.pageInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.pageInput.blur();
    });
    document
      .getElementById('btn-fit')!
      .addEventListener('click', () => void this.fitWidth().catch(onError));
    container.addEventListener(
      'scroll',
      () => {
        if (this.scrollQueued) return;
        this.scrollQueued = true;
        requestAnimationFrame(() => {
          this.scrollQueued = false;
          this.updatePage();
        });
      },
      { passive: true },
    );
    viewer.addPageRenderedListener(() => this.updatePage());
    this.setupResizer();
  }

  selectTab(name: WorkspaceTab): void {
    this.scrollPositions[this.activeTab] = this.panelContent.scrollTop;
    this.activeTab = name;
    for (const key of TABS) {
      const selected = name === key;
      const tab = document.getElementById(`tab-${key}`)!;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(`${key}-pane`)!.hidden = !selected;
    }
    this.panelContent.scrollTop = this.scrollPositions[name];
  }

  revealSelection(): void {
    this.selectTab('sentence');
    this.panelContent.scrollTop = 0;
  }

  reset(): void {
    this.scrollPositions.sentence = 0;
    this.scrollPositions.paper = 0;
    this.scrollPositions.work = 0;
    this.selectTab('sentence');
    this.panelContent.scrollTop = 0;
    document.getElementById('welcome')!.hidden = true;
    document.getElementById('notes-empty')!.hidden = false;
    document.getElementById('notes-count')!.hidden = true;
    this.setControls(false);
    this.pageInput.value = '1';
    document.getElementById('page-total')!.textContent = '/ —';
  }

  documentReady(): void {
    this.setControls(true);
    this.pageInput.max = String(this.viewer.document?.numPages ?? 1);
    document.getElementById('page-total')!.textContent = `/ ${this.viewer.document?.numPages ?? 0}`;
    this.updatePage();
  }

  private setControls(enabled: boolean): void {
    for (const id of [
      'page-number',
      'btn-page-prev',
      'btn-page-next',
      'btn-zoom-in',
      'btn-zoom-out',
      'btn-fit',
    ]) {
      (document.getElementById(id) as HTMLButtonElement | HTMLInputElement).disabled = !enabled;
    }
  }

  private goTo(page: number): void {
    const total = this.viewer.document?.numPages ?? 0;
    if (!total) return;
    const next = Math.max(1, Math.min(total, Math.round(page) || 1));
    const element = this.viewer.pageElement(next - 1);
    if (!element) return;
    this.container.scrollTop +=
      element.getBoundingClientRect().top - this.container.getBoundingClientRect().top - 24;
    this.pageInput.value = String(next);
    this.updatePage();
  }

  private updatePage(): void {
    const total = this.viewer.document?.numPages ?? 0;
    if (!total) return;
    const top = this.container.getBoundingClientRect().top;
    let current = 1;
    for (let i = 0; i < total; i++) {
      const rect = this.viewer.pageElement(i)?.getBoundingClientRect();
      if (rect && rect.top < top + this.container.clientHeight * 0.45) current = i + 1;
    }
    if (document.activeElement !== this.pageInput) this.pageInput.value = String(current);
    (document.getElementById('btn-page-prev') as HTMLButtonElement).disabled = current <= 1;
    (document.getElementById('btn-page-next') as HTMLButtonElement).disabled = current >= total;
  }

  private async fitWidth(): Promise<void> {
    const index = Math.max(0, Number(this.pageInput.value) - 1);
    const page = this.viewer.pageProxyOf(index);
    if (!page) return;
    await this.viewer.setScale(
      (this.container.clientWidth - 48) / page.getViewport({ scale: 1 }).width,
    );
    this.onZoom();
    this.goTo(index + 1);
  }

  private setupResizer(): void {
    const handle = document.getElementById('panel-resizer')!;
    const panel = document.getElementById('panel')!;
    const maxWidth = (): number => Math.min(680, Math.max(340, window.innerWidth - 380));
    const apply = (width: number): void => {
      const clamped = Math.max(340, Math.min(maxWidth(), width));
      document.documentElement.style.setProperty('--panel-width', `${clamped}px`);
      handle.setAttribute('aria-valuenow', String(Math.round(clamped)));
      handle.setAttribute('aria-valuemax', String(maxWidth()));
    };
    try {
      const saved = Number(localStorage.getItem('paperlens-panel-width'));
      if (saved >= 340) apply(saved);
    } catch {
      /* 저장소를 쓸 수 없어도 너비 조절은 유지한다. */
    }
    const save = (): void => {
      try {
        localStorage.setItem('paperlens-panel-width', String(panel.clientWidth));
      } catch {
        /* 선택적 설정 */
      }
    };
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add('resizing');
    });
    handle.addEventListener('pointermove', (event) => {
      if (handle.hasPointerCapture(event.pointerId)) apply(window.innerWidth - event.clientX);
    });
    handle.addEventListener('pointerup', (event) => {
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    });
    handle.addEventListener('lostpointercapture', () => {
      document.body.classList.remove('resizing');
      save();
    });
    handle.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      apply(
        event.key === 'Home'
          ? 340
          : event.key === 'End'
            ? maxWidth()
            : panel.clientWidth + (event.key === 'ArrowLeft' ? 24 : -24),
      );
      save();
    });
    window.addEventListener('resize', () => {
      if (window.innerWidth > 760) apply(panel.clientWidth);
    });
    handle.setAttribute('aria-valuenow', String(panel.clientWidth));
    handle.setAttribute('aria-valuemax', String(maxWidth()));
  }
}
