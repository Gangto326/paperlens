import type { AdditionalControl } from './additional-explanations';
import type { SelectionResult } from '@shared/mapping/selection';
import type { InlinePart, RichBlock } from './rich-text';
import {
  FURTHER_SOURCES_TITLE,
  NO_TRANSLATIONS,
  READ_SOURCES_TITLE,
  selectionView,
  type ConceptView,
  type ExplanationSectionView,
  type SentenceView,
  type SourceLinkView,
  type TranslationLookup,
} from './selection-view';

/**
 * 우측 패널 DOM(C1.16·C2.9). 선택 문장의 원문·매핑 상태와 저장된 번역·해설을 보여준다. 출처는 M4에서 붙는다.
 * 표시는 메모리 조회만으로 끝나므로 네트워크를 기다리지 않는다 — 200ms 목표는 호출 쪽에서 측정한다.
 */
export class SentencePanel {
  private readonly summaryEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private lookup: TranslationLookup = NO_TRANSLATIONS;
  private last: SelectionResult | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly additional?: AdditionalControl,
  ) {
    root.replaceChildren();
    this.summaryEl = document.createElement('p');
    this.summaryEl.className = 'selection-summary muted';
    this.listEl = document.createElement('div');
    this.listEl.className = 'sentence-list';
    root.append(this.summaryEl, this.listEl);
    this.clear();
  }

  clear(): void {
    this.summaryEl.textContent = '';
    this.listEl.replaceChildren();
    this.last = null;
    const empty = document.createElement('div');
    empty.className = 'panel-empty';
    const glyph = document.createElement('span');
    glyph.className = 'empty-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = '❞';
    const title = document.createElement('h3');
    title.textContent = '궁금한 문장에 머물러 보세요';
    const hint = document.createElement('p');
    hint.textContent =
      '원문을 클릭하거나 드래그하면 선택한 문장의 번역과 해설이 여기에 나타납니다.';
    empty.append(glyph, title, hint);
    this.listEl.append(empty);
  }

  /** 번역 조회기를 바꾸고, 보여주던 선택이 있으면 새 결과로 다시 그린다. */
  setTranslations(lookup: TranslationLookup): void {
    this.lookup = lookup;
    if (this.last) {
      const key = (details: HTMLDetailsElement): string =>
        `${details.closest<HTMLElement>('.sentence')?.dataset['sentenceId']}/${details.dataset['additionalKey'] ?? details.dataset['conceptId'] ?? details.className}`;
      const states = new Map(
        [...this.root.querySelectorAll<HTMLDetailsElement>('.sentence details')].map((details) => [
          key(details),
          details.open,
        ]),
      );
      this.show(this.last);
      this.root.querySelectorAll<HTMLDetailsElement>('.sentence details').forEach((details) => {
        const open = states.get(key(details));
        if (open !== undefined) details.open = open;
      });
    }
  }

  /** 결과를 그린다. 빈 선택(empty_selection)은 이전 표시를 유지한다. */
  show(result: SelectionResult): void {
    if (result.reason === 'empty_selection') return;
    this.last = result;
    const view = selectionView(result, this.lookup);
    this.summaryEl.textContent = view.summary;
    this.listEl.replaceChildren(
      ...view.sentences.map((sentence) => renderSentence(sentence, this.additional)),
    );
  }
}

function renderSentence(s: SentenceView, additional?: AdditionalControl): HTMLElement {
  const article = document.createElement('article');
  article.className = `sentence status-${s.status}`;
  article.dataset['sentenceId'] = s.id;

  const meta = document.createElement('div');
  meta.className = 'sentence-meta muted';
  const label = document.createElement('span');
  label.textContent = s.label;
  const status = document.createElement('span');
  status.className = `status-badge status-${s.status}`;
  status.textContent = s.statusLabel;
  meta.append(label, status);
  article.append(meta);

  if (s.notice) {
    const notice = document.createElement('p');
    notice.className = 'sentence-notice';
    notice.textContent = s.notice;
    article.append(notice);
  }

  const en = document.createElement('p');
  en.className = 'sentence-en';
  en.lang = 'en';
  for (const part of s.en) {
    if (part.kind === 'equation') {
      const code = document.createElement('code');
      code.className = 'eq-token';
      code.textContent = part.text;
      en.append(code);
    } else {
      en.append(document.createTextNode(part.text));
    }
  }
  article.append(en);

  const t = s.translation;
  article.dataset['translation'] = t.state;
  if (t.state !== 'complete') {
    const waiting = document.createElement('p');
    waiting.className = `sentence-translation muted translation-${t.state}`;
    waiting.textContent = t.text;
    article.append(waiting);
    return article;
  }
  const ko = document.createElement('p');
  ko.className = 'sentence-ko';
  ko.lang = 'ko';
  ko.textContent = t.ko;
  const translationLabel = document.createElement('div');
  translationLabel.className = 'translation-label';
  translationLabel.textContent = '번역';
  article.append(translationLabel, ko);
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'copy-button';
  copy.textContent = '번역 복사';
  copy.setAttribute('aria-label', `${s.label} 번역 복사`);
  copy.addEventListener('click', () => {
    void navigator.clipboard
      .writeText(t.ko)
      .then(() => {
        copy.textContent = '복사됨';
        setTimeout(() => {
          copy.textContent = '번역 복사';
        }, 1800);
      })
      .catch(() => {
        copy.textContent = '복사 실패 · 다시 시도';
      });
  });
  meta.append(copy);
  if (t.previous !== null) {
    const previous = document.createElement('p');
    previous.className = 'sentence-previous muted';
    previous.lang = 'ko';
    previous.textContent = t.previous;
    article.append(previous);
  }
  if (t.note !== null) {
    const note = document.createElement('p');
    note.className = 'sentence-note';
    note.lang = 'ko';
    note.textContent = t.note;
    article.append(note);
    if (additional)
      article.append(additional({ kind: 'section', sentenceId: s.id, section: 'note' }));
  }
  for (const section of t.sections) {
    const element = renderSection(section);
    if (additional)
      element.append(additional({ kind: 'section', sentenceId: s.id, section: section.key }));
    article.append(element);
  }
  if (t.concepts.length > 0) {
    const list = document.createElement('div');
    list.className = 'concept-list';
    list.append(...t.concepts.map((concept) => renderConcept(concept, additional)));
    const heading = document.createElement('h3');
    heading.className = 'concepts-heading';
    heading.textContent = `함께 알아둘 개념 ${t.concepts.length}`;
    article.append(heading, list);
  }
  for (const warning of t.warnings) {
    const w = document.createElement('p');
    w.className = 'sentence-warning muted';
    w.textContent = `주의: ${warning}`;
    article.append(w);
  }
  return article;
}

/** 해설 칸 하나. 접어 둔 칸은 제목만 보이고 누르면 펼쳐진다. */
export function renderSection(section: ExplanationSectionView): HTMLElement {
  const details = document.createElement('details');
  details.className = `explain explain-${section.key}`;
  details.open = section.open;
  const summary = document.createElement('summary');
  summary.textContent = section.label;
  details.append(summary, renderRich(section.blocks));
  return details;
}

function appendInline(parent: HTMLElement, parts: readonly InlinePart[]): void {
  for (const part of parts) {
    if (part.bold) {
      const strong = document.createElement('strong');
      strong.textContent = part.text;
      parent.append(strong);
    } else {
      parent.append(document.createTextNode(part.text));
    }
  }
}

/** 단락, 목록, 표로 나뉜 글. 글자는 textContent로만 넣는다. */
export function renderRich(blocks: readonly RichBlock[]): HTMLElement {
  const root = document.createElement('div');
  root.className = 'rich';
  root.lang = 'ko';
  for (const block of blocks) {
    if (block.kind === 'paragraph') {
      const p = document.createElement('p');
      block.lines.forEach((line, i) => {
        if (i > 0) p.append(document.createElement('br'));
        appendInline(p, line);
      });
      root.append(p);
    } else if (block.kind === 'list') {
      const list = document.createElement(block.ordered ? 'ol' : 'ul');
      for (const item of block.items) {
        const li = document.createElement('li');
        appendInline(li, item);
        list.append(li);
      }
      root.append(list);
    } else {
      const wrap = document.createElement('div');
      wrap.className = 'rich-table';
      const table = document.createElement('table');
      const head = document.createElement('tr');
      for (const cell of block.header) {
        const th = document.createElement('th');
        appendInline(th, cell);
        head.append(th);
      }
      const thead = document.createElement('thead');
      thead.append(head);
      const tbody = document.createElement('tbody');
      for (const row of block.rows) {
        const tr = document.createElement('tr');
        for (const cell of row) {
          const td = document.createElement('td');
          appendInline(td, cell);
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(thead, tbody);
      wrap.append(table);
      root.append(wrap);
    }
  }
  return root;
}

/** 개념 카드. 이름만 보이고 누르면 펼쳐진다. */
export function renderConcept(concept: ConceptView, additional?: AdditionalControl): HTMLElement {
  const details = document.createElement('details');
  details.className = 'concept';
  details.dataset['conceptId'] = concept.id;
  const summary = document.createElement('summary');
  summary.textContent = concept.title;
  details.append(summary);
  if (concept.badge !== null) {
    const badge = document.createElement('p');
    badge.className = 'concept-badge muted';
    badge.textContent = concept.badge;
    details.append(badge);
  }
  const rows = document.createElement('dl');
  for (const row of concept.rows) {
    const label = document.createElement('dt');
    label.textContent = row.label;
    const text = document.createElement('dd');
    text.append(renderRich(row.blocks));
    rows.append(label, text);
  }
  details.append(rows);
  if (concept.sources.length > 0) details.append(renderLinks(READ_SOURCES_TITLE, concept.sources));
  if (concept.further.length > 0) {
    details.append(renderLinks(FURTHER_SOURCES_TITLE, concept.further));
  }
  if (additional) details.append(additional({ kind: 'concept', conceptId: concept.id }));
  return details;
}

/** 자료 링크 목록. 링크는 새 창 요청으로 나가고 메인 프로세스가 시스템 브라우저로 연다. */
function renderLinks(title: string, links: SourceLinkView[]): HTMLElement {
  const section = document.createElement('div');
  section.className = 'concept-sources';
  const heading = document.createElement('p');
  heading.className = 'concept-sources-title';
  heading.textContent = title;
  const list = document.createElement('ul');
  for (const link of links) {
    const item = document.createElement('li');
    const anchor = document.createElement('a');
    anchor.href = link.url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = link.title;
    item.append(anchor);
    if (link.meta !== '') {
      const meta = document.createElement('span');
      meta.className = 'muted concept-source-meta';
      meta.textContent = ` ${link.meta}`;
      item.append(meta);
    }
    if (link.supports !== null) {
      const supports = document.createElement('p');
      supports.className = 'concept-source-supports';
      supports.lang = 'ko';
      supports.textContent = link.supports;
      item.append(supports);
    }
    list.append(item);
  }
  section.append(heading, list);
  return section;
}
