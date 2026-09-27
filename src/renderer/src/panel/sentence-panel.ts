import type { SelectionResult } from '@shared/mapping/selection';
import {
  NO_TRANSLATIONS,
  selectionView,
  type SentenceView,
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

  constructor(private readonly root: HTMLElement) {
    root.replaceChildren();
    this.summaryEl = document.createElement('p');
    this.summaryEl.className = 'selection-summary muted';
    this.listEl = document.createElement('div');
    this.listEl.className = 'sentence-list';
    root.append(this.summaryEl, this.listEl);
  }

  clear(): void {
    this.summaryEl.textContent = '';
    this.listEl.replaceChildren();
    this.last = null;
  }

  /** 번역 조회기를 바꾸고, 보여주던 선택이 있으면 새 결과로 다시 그린다. */
  setTranslations(lookup: TranslationLookup): void {
    this.lookup = lookup;
    if (this.last) this.show(this.last);
  }

  /** 결과를 그린다. 빈 선택(empty_selection)은 이전 표시를 유지한다. */
  show(result: SelectionResult): void {
    if (result.reason === 'empty_selection') return;
    this.last = result;
    const view = selectionView(result, this.lookup);
    this.summaryEl.textContent = view.summary;
    this.listEl.replaceChildren(...view.sentences.map(renderSentence));
  }
}

function renderSentence(s: SentenceView): HTMLElement {
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
  article.append(ko);
  if (t.note !== null) {
    const note = document.createElement('p');
    note.className = 'sentence-note';
    note.lang = 'ko';
    note.textContent = t.note;
    article.append(note);
  }
  for (const warning of t.warnings) {
    const w = document.createElement('p');
    w.className = 'sentence-warning muted';
    w.textContent = `주의: ${warning}`;
    article.append(w);
  }
  return article;
}
