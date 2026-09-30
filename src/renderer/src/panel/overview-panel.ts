import type { TranslationSnapshot } from '@shared/ipc';
import { overviewView } from './overview-view';
import { renderConcept, renderRich } from './sentence-panel';

/** 개요·용어집·개념 카드 패널(C3.7). 접이식 셋. 글자는 textContent로만 넣는다. */
export class OverviewPanel {
  constructor(private readonly root: HTMLElement) {}

  set(snapshot: TranslationSnapshot | null): void {
    const view = overviewView(snapshot);
    const open = new Set(
      [...this.root.querySelectorAll<HTMLDetailsElement>('details.overview-block')]
        .filter((d) => d.open)
        .map((d) => d.dataset['block'] ?? ''),
    );
    this.root.replaceChildren();
    this.root.hidden = view === null;
    if (view === null) return;
    const block = (key: string, title: string, body: HTMLElement): HTMLDetailsElement => {
      const details = document.createElement('details');
      details.className = 'overview-block';
      details.dataset['block'] = key;
      details.open = open.has(key);
      const summary = document.createElement('summary');
      summary.textContent = title;
      details.append(summary, body);
      return details;
    };
    if (view.items.length > 0) {
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
      this.root.append(block('overview', '논문 개요', dl));
    }
    if (view.glossary.length > 0) {
      const table = document.createElement('table');
      table.className = 'glossary';
      for (const row of view.glossary) {
        const tr = document.createElement('tr');
        for (const text of [row.term, row.ko, row.meaning]) {
          const td = document.createElement('td');
          td.textContent = text;
          tr.append(td);
        }
        table.append(tr);
      }
      this.root.append(block('glossary', `용어집 (${view.glossary.length})`, table));
    }
    if (view.concepts.length > 0) {
      const list = document.createElement('div');
      list.className = 'concept-list';
      list.append(...view.concepts.map(renderConcept));
      this.root.append(block('concepts', `개념 카드 (${view.concepts.length})`, list));
    }
  }
}
