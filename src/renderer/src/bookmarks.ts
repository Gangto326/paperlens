import type { SentenceIndex, SentenceIndexEntry } from '@shared/ipc';
import { bookmarkKey, decodeBookmarks, type Bookmark } from './bookmark-store';

export class Bookmarks {
  private sha: string | null = null;
  private index: SentenceIndex | null = null;
  private saved: Bookmark[] = [];
  private selected: SentenceIndexEntry[] = [];
  private storageReady = false;
  private readonly toggle = document.querySelector<HTMLButtonElement>('#btn-bookmark-toggle')!;
  private readonly open = document.querySelector<HTMLButtonElement>('#btn-bookmarks')!;
  private readonly popover = document.getElementById('bookmarks-popover')!;
  private readonly list = document.getElementById('bookmark-list')!;

  constructor(
    private readonly navigate: (id: string) => void,
    private readonly status: (message: string) => void,
  ) {
    this.toggle.addEventListener('click', () => this.toggleSelection());
    document.addEventListener('keydown', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.altKey ||
        event.shiftKey ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== 'd' ||
        document.querySelector('dialog[open], :popover-open') ||
        target?.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
        ) ||
        this.toggle.disabled
      )
        return;
      event.preventDefault();
      this.toggleSelection();
    });
  }

  setDocument(sha: string | null, index: SentenceIndex | null): void {
    this.sha = sha;
    this.index = index;
    this.selected = [];
    this.saved = [];
    this.storageReady = false;
    if (this.popover.matches(':popover-open')) this.popover.hidePopover();
    if (sha && index) {
      try {
        this.saved = decodeBookmarks(localStorage.getItem(bookmarkKey(sha)));
        this.storageReady = true;
      } catch {
        this.status('책갈피를 불러오지 못했습니다. 저장 공간을 확인한 뒤 논문을 다시 열어주세요.');
      }
    }
    this.render();
  }

  setSelection(sentences: SentenceIndexEntry[]): void {
    this.selected = sentences;
    this.updateControls();
  }

  private isSaved(sentence: SentenceIndexEntry): boolean {
    return this.saved.some((item) => item.id === sentence.id && item.en === sentence.en);
  }

  private toggleSelection(): void {
    if (!this.sha || !this.storageReady || !this.selected.length) return;
    const remove = this.selected.every((sentence) => this.isSaved(sentence));
    const ids = new Set(this.selected.map((sentence) => sentence.id));
    const updated = this.saved.filter((item) => !ids.has(item.id));
    if (!remove) updated.push(...this.selected.map(({ id, en, page }) => ({ id, en, page })));
    if (this.save(updated)) {
      this.status(
        remove
          ? '선택한 문장의 책갈피를 해제했습니다.'
          : '책갈피에 저장했습니다. 상단 책갈피에서 다시 찾아갈 수 있습니다.',
      );
    }
  }

  private save(updated: Bookmark[]): boolean {
    if (!this.sha || !this.storageReady) return false;
    try {
      localStorage.setItem(bookmarkKey(this.sha), JSON.stringify(updated));
      this.saved = updated;
      this.render();
      return true;
    } catch {
      this.status('책갈피를 저장하지 못했습니다. 저장 공간을 확인한 뒤 다시 시도하세요.');
      return false;
    }
  }

  private updateControls(): void {
    this.toggle.disabled = !this.storageReady || this.selected.length === 0;
    const allSaved =
      this.selected.length > 0 && this.selected.every((sentence) => this.isSaved(sentence));
    this.toggle.setAttribute('aria-pressed', String(allSaved));
    this.toggle.textContent = allSaved ? '저장됨' : '책갈피';
    this.toggle.title = `선택한 문장 책갈피 ${allSaved ? '해제' : '추가'} (⌘/Ctrl+D)`;
    this.toggle.setAttribute('aria-label', this.toggle.title);
    this.open.disabled = !this.index;
    document.getElementById('bookmark-count')!.textContent = String(this.saved.length);
  }

  private render(): void {
    this.updateControls();
    this.list.replaceChildren();
    const empty = document.getElementById('bookmarks-empty')!;
    empty.hidden = this.saved.length > 0;
    empty.textContent = this.storageReady
      ? '저장한 문장이 없습니다.'
      : '책갈피를 불러올 수 없습니다.';
    const byId = new Map(this.index?.sentences.map((sentence) => [sentence.id, sentence]));
    const entries = [...this.saved].sort(
      (a, b) =>
        a.page - b.page ||
        (byId.get(a.id)?.order ?? Infinity) - (byId.get(b.id)?.order ?? Infinity),
    );
    for (const item of entries) {
      const sentence = byId.get(item.id);
      const available = sentence?.en === item.en;
      const row = document.createElement('li');
      row.className = 'bookmark-entry';
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'bookmark-jump';
      jump.disabled = !available;
      const meta = document.createElement('span');
      meta.className = 'bookmark-meta';
      meta.textContent = `${item.page + 1}쪽${available ? ` · 문장 ${sentence.order + 1}` : ' · 현재 문장에서 찾을 수 없음'}`;
      const text = document.createElement('span');
      text.className = 'bookmark-text';
      text.textContent = item.en;
      jump.append(meta, text);
      jump.addEventListener('click', () => {
        this.popover.hidePopover();
        this.navigate(item.id);
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'bookmark-remove';
      remove.textContent = '삭제';
      remove.setAttribute('aria-label', `${item.page + 1}쪽 책갈피 삭제: ${item.en}`);
      remove.addEventListener('click', () => {
        const position = entries.indexOf(item);
        if (!this.save(this.saved.filter((bookmark) => bookmark.id !== item.id))) return;
        const remaining = this.list.querySelectorAll<HTMLButtonElement>('.bookmark-remove');
        const focus =
          remaining[Math.min(position, remaining.length - 1)] ??
          this.popover.querySelector<HTMLButtonElement>('header button');
        focus?.focus();
        this.status('책갈피를 삭제했습니다.');
      });
      row.append(jump, remove);
      this.list.append(row);
    }
  }
}
