import type { SelectionResult } from '@shared/mapping/selection';
import { selectionView, type SentenceView } from './selection-view';

/**
 * 우측 패널 DOM(C1.16). 선택 문장의 원문·매핑 상태를 보여준다. 번역·해설·출처는 M2 이후 같은 자리에 붙는다.
 * 표시는 캐시(메모리 색인) 조회만으로 끝나므로 네트워크를 기다리지 않는다 — 200ms 목표는 호출 쪽에서 측정한다.
 */
export class SentencePanel {
  private readonly summaryEl: HTMLElement;
  private readonly listEl: HTMLElement;

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
  }

  /** 결과를 그린다. 빈 선택(empty_selection)은 이전 표시를 유지한다. */
  show(result: SelectionResult): void {
    if (result.reason === 'empty_selection') return;
    const view = selectionView(result);
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

  const tr = document.createElement('p');
  tr.className = 'sentence-translation muted';
  tr.textContent = s.translation;
  article.append(tr);
  return article;
}
