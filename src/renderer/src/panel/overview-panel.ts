import type { AdditionalControl } from './additional-explanations';
import type { TranslationSnapshot } from '@shared/ipc';
import { overviewView } from './overview-view';
import { renderConcept, renderRich } from './sentence-panel';

type NoteSection = 'overview' | 'glossary' | 'concepts';
const SECTIONS: NoteSection[] = ['overview', 'glossary', 'concepts'];

/** 논문 자료는 독립된 탭으로, 용어는 한 항목당 패널 전체 폭으로 읽는다. */
export class OverviewPanel {
  private active: NoteSection = 'overview';
  private query = '';

  constructor(
    private readonly root: HTMLElement,
    private readonly additional?: AdditionalControl,
  ) {}

  set(snapshot: TranslationSnapshot | null): void {
    const view = overviewView(snapshot);
    if (!snapshot) {
      this.query = '';
      this.active = 'overview';
    }
    const oldSearch = this.root.querySelector<HTMLInputElement>('.notes-search');
    const restoreSearch = oldSearch === document.activeElement;
    const caret = oldSearch?.selectionStart ?? null;
    const conceptOpen = new Set(
      [...this.root.querySelectorAll<HTMLDetailsElement>('details.concept[open]')].map(
        (d) => d.dataset['conceptId'],
      ),
    );
    this.root.replaceChildren();
    this.root.hidden = view === null;
    if (view === null) return;

    const tabs = document.createElement('div');
    tabs.className = 'notes-sections';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '논문 노트 분류');
    const labels = {
      overview: '개요',
      glossary: `용어집 ${view.glossary.length}`,
      concepts: `개념 ${view.concepts.length}`,
    };
    for (const key of SECTIONS) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.id = `notes-tab-${key}`;
      tab.dataset['section'] = key;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', `notes-${key}`);
      tab.textContent = labels[key];
      tab.addEventListener('click', () => this.select(key));
      tab.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const position = SECTIONS.indexOf(key);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? 2
              : (position + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
        this.select(SECTIONS[next]!);
        this.root.querySelector<HTMLButtonElement>(`#notes-tab-${SECTIONS[next]}`)?.focus();
      });
      tabs.append(tab);
    }
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'notes-search';
    search.value = this.query;
    search.addEventListener('input', () => {
      this.query = search.value;
      this.filter();
    });
    const count = document.createElement('p');
    count.className = 'notes-result-count';
    count.setAttribute('role', 'status');
    const toolbar = document.createElement('div');
    toolbar.className = 'notes-toolbar';
    toolbar.append(tabs, search, count);
    this.root.append(toolbar);

    const section = (key: NoteSection): HTMLElement => {
      const element = document.createElement('section');
      element.className = 'note-section';
      element.id = `notes-${key}`;
      element.dataset['section'] = key;
      element.setAttribute('role', 'tabpanel');
      element.setAttribute('aria-labelledby', `notes-tab-${key}`);
      this.root.append(element);
      return element;
    };
    const overview = section('overview');
    const dl = document.createElement('dl');
    dl.className = 'overview-items';
    for (const item of view.items) {
      const dt = document.createElement('dt');
      dt.textContent = item.label;
      const dd = document.createElement('dd');
      dd.lang = 'ko';
      dd.append(renderRich(item.blocks));
      dl.append(dt, dd);
    }
    overview.append(dl);

    const glossary = section('glossary');
    const list = document.createElement('dl');
    list.className = 'glossary-list';
    for (const row of view.glossary) {
      const entry = document.createElement('div');
      entry.className = 'glossary-entry';
      const term = document.createElement('dt');
      term.className = 'glossary-term';
      term.lang = 'en';
      term.textContent = row.term;
      const definition = document.createElement('dd');
      const ko = document.createElement('p');
      ko.className = 'glossary-ko';
      ko.textContent = row.ko;
      const meaning = document.createElement('p');
      meaning.className = 'glossary-meaning';
      meaning.textContent = row.meaning;
      definition.append(ko, meaning);
      entry.append(term, definition);
      list.append(entry);
    }
    glossary.append(list);

    const concepts = section('concepts');
    const cards = document.createElement('div');
    cards.className = 'concept-list';
    cards.append(
      ...view.concepts.map((concept) => {
        const element = renderConcept(concept, this.additional) as HTMLDetailsElement;
        element.open = conceptOpen.has(concept.id);
        return element;
      }),
    );
    concepts.append(cards);
    const empty = document.createElement('p');
    empty.className = 'search-empty';
    empty.textContent = '일치하는 항목이 없습니다. 다른 검색어를 입력하세요.';
    this.root.append(empty);
    this.select(this.active, false);
    if (restoreSearch && !search.hidden) {
      search.focus({ preventScroll: true });
      if (caret !== null) search.setSelectionRange(caret, caret);
    }
  }

  private select(key: NoteSection, resetQuery = true): void {
    if (this.active !== key && resetQuery) this.query = '';
    this.active = key;
    this.root.querySelectorAll<HTMLButtonElement>('.notes-sections button').forEach((tab) => {
      const selected = tab.dataset['section'] === key;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    this.root.querySelectorAll<HTMLElement>('.note-section').forEach((section) => {
      section.hidden = section.dataset['section'] !== key;
    });
    const search = this.root.querySelector<HTMLInputElement>('.notes-search')!;
    search.hidden = key === 'overview';
    search.value = this.query;
    search.placeholder =
      key === 'glossary' ? '원어·한국어·뜻으로 용어 찾기' : '이름·설명으로 개념 찾기';
    search.setAttribute('aria-label', search.placeholder);
    this.filter();
    // 긴 개요를 읽다가 다른 분류로 바꿔도 첫 항목부터 보이게 한다.
    if (resetQuery) this.root.closest('#panel-content')?.scrollTo({ top: 0 });
  }

  private filter(): void {
    const query = this.query.trim().toLocaleLowerCase();
    const selector = this.active === 'glossary' ? '.glossary-entry' : '#notes-concepts .concept';
    const items = [...this.root.querySelectorAll<HTMLElement>(selector)];
    let matches = 0;
    for (const item of items) {
      item.hidden = query !== '' && !(item.textContent ?? '').toLocaleLowerCase().includes(query);
      if (!item.hidden) matches++;
    }
    const count = this.root.querySelector<HTMLElement>('.notes-result-count')!;
    count.hidden = this.active === 'overview';
    count.textContent = query ? `${items.length}개 중 ${matches}개` : `전체 ${items.length}개`;
    const empty = this.root.querySelector<HTMLElement>('.search-empty')!;
    empty.hidden = this.active === 'overview' || matches > 0;
    empty.textContent = query
      ? '일치하는 항목이 없습니다. 다른 검색어를 입력하세요.'
      : '아직 정리된 항목이 없습니다. 분석이 끝나면 이곳에 표시됩니다.';
  }
}
