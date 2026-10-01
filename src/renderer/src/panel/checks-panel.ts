import { CHECKING_VIEW, checksView, type ChecksView } from './checks-view';

/**
 * 의존 서비스 점검 패널(C5.1). 시작할 때 한 번 점검하고, 문제가 있으면 펼친다.
 * 글자는 textContent로만 넣는다. 로그인 단추는 계정 패널의 로그인과 같은 일을 한다(호출자가 잇는다).
 */
export class ChecksPanel {
  private view: ChecksView = CHECKING_VIEW;
  private busy = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly deps: {
      login: () => Promise<void>;
      onError: (err: unknown) => void;
      onChanged?: (view: ChecksView) => void;
    },
  ) {
    this.render(true);
  }

  async refresh(openIfProblem = true): Promise<ChecksView> {
    try {
      this.view = checksView(await window.paperlens.checkDependencies());
    } catch (err) {
      this.deps.onError(err);
    }
    this.render(openIfProblem && !this.view.allOk);
    this.deps.onChanged?.(this.view);
    return this.view;
  }

  private async act(kind: 'start_grobid' | 'login'): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (kind === 'start_grobid') {
        const result = await window.paperlens.startGrobid();
        const note = this.root.querySelector<HTMLElement>('.checks-note');
        if (note) note.textContent = result.message;
        if (result.started) {
          // 준비되기까지 수십 초 걸린다. 몇 번 다시 확인한다.
          for (let i = 0; i < 12; i += 1) {
            await new Promise((r) => setTimeout(r, 5_000));
            const view = await this.refresh(false);
            if (view.rows.find((r) => r.key === 'grobid')?.state === 'ok') break;
          }
        }
      } else {
        await this.deps.login();
      }
    } catch (err) {
      this.deps.onError(err);
    } finally {
      this.busy = false;
    }
  }

  private render(open: boolean): void {
    const wasOpen = this.root.querySelector<HTMLDetailsElement>('details')?.open ?? open;
    this.root.replaceChildren();
    const details = document.createElement('details');
    details.className = 'checks';
    details.open = open || wasOpen;
    const summary = document.createElement('summary');
    summary.textContent = this.view.title;
    summary.className = this.view.allOk ? 'checks-ok' : 'checks-problem';
    details.append(summary);
    const list = document.createElement('ul');
    list.className = 'checks-list';
    for (const row of this.view.rows) {
      const li = document.createElement('li');
      li.className = `check check-${row.state}`;
      const label = document.createElement('span');
      label.className = 'check-label';
      label.textContent = row.label;
      const text = document.createElement('span');
      text.className = 'check-text';
      text.textContent = row.text;
      li.append(label, text);
      if (row.guidance !== null) {
        const guidance = document.createElement('p');
        guidance.className = 'check-guidance muted';
        guidance.textContent = row.guidance;
        li.append(guidance);
      }
      if (row.action !== null) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = row.action.label;
        const kind = row.action.kind;
        button.addEventListener('click', () => void this.act(kind));
        li.append(button);
      }
      list.append(li);
    }
    details.append(list);
    const note = document.createElement('p');
    note.className = 'checks-note muted';
    const again = document.createElement('button');
    again.type = 'button';
    again.textContent = '다시 확인';
    again.addEventListener('click', () => void this.refresh(false));
    details.append(note, again);
    this.root.append(details);
  }
}
