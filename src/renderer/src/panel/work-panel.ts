import { workView } from './work-view';
import type { Preparation, WorkProgress } from '@shared/work-status';

const $ = (id: string): HTMLElement => document.getElementById(id)!;
export function durationText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60
    ? `${seconds}초`
    : `${Math.floor(seconds / 60)}분 ${String(seconds % 60).padStart(2, '0')}초`;
}

export class WorkPanel {
  progress: WorkProgress | null = null;
  private sha: string | null = null;
  private preparation: Preparation | null = null;
  constructor(
    private readonly refresh: () => Promise<void>,
    private readonly error: (error: unknown) => void,
  ) {
    $('btn-preparation-refresh').addEventListener('click', () => {
      void this.refresh().catch(error);
    });
    setInterval(() => this.clock(), 1000);
  }
  reset(sha: string | null): void {
    this.sha = sha;
    this.progress = null;
    this.preparation = null;
    $('work-progress').hidden = true;
    $('work-empty').hidden = false;
    $('preparation-resources').replaceChildren();
    $('preparation-message').textContent =
      '번역을 시작하면 기다리는 동안 볼 입문 영상과 해설 글을 찾습니다.';
    ($('btn-preparation-refresh') as HTMLButtonElement).disabled = true;
    this.clock();
  }
  setProgress(p: WorkProgress): boolean {
    if (p.pdfSha256 !== this.sha || (this.progress && p.revision < this.progress.revision))
      return false;
    this.progress = p;
    $('work-empty').hidden = true;
    $('work-progress').hidden = false;
    const view = workView(p);
    $('work-progress').dataset['running'] = String(p.running);
    $('work-progress').dataset['complete'] = String(p.state === 'complete');
    $('work-state').textContent = view.title;
    $('work-badge').textContent = view.badge;
    $('work-description').textContent = view.description;
    const steps = $('work-steps');
    steps.replaceChildren();
    for (const [index, phase] of view.steps.entries()) {
      const li = document.createElement('li');
      li.dataset['state'] = phase.state;
      if (phase.state === 'current') li.setAttribute('aria-current', 'step');
      const marker = document.createElement('span');
      marker.className = 'work-step-marker';
      marker.textContent = phase.state === 'done' ? '✓' : String(index + 1).padStart(2, '0');
      marker.setAttribute('aria-hidden', 'true');
      const body = document.createElement('div');
      const label = document.createElement('strong');
      label.textContent = phase.label;
      const detail = document.createElement('small');
      detail.textContent = phase.detail;
      body.append(label, detail);
      const state = document.createElement('span');
      state.className = 'work-step-status';
      state.textContent = phase.status;
      li.append(marker, body, state);
      steps.append(li);
    }
    $('work-counts').textContent = p.total
      ? `${p.completed} / ${p.total} 구간 · ${view.percent}%`
      : p.step
        ? `${p.step.done} / ${p.step.total} 준비 작업`
        : '준비 중';
    const chunks = $('work-chunks');
    chunks.replaceChildren();
    chunks.setAttribute(
      'aria-label',
      p.total
        ? `문장 번역 ${p.total}구간 중 ${p.completed}구간 완료, ${view.active}구간 진행, ${p.failed}구간 실패`
        : '문장 번역 준비 중',
    );
    chunks.dataset['empty'] = String(p.chunks.length === 0);
    for (const c of p.chunks) {
      const item = document.createElement('span');
      const state = !p.running && c.state === 'running' ? 'pending' : c.state;
      item.dataset['state'] = state;
      item.title = `${c.index + 1}번 구간 · ${{ pending: '대기', running: '번역 중', complete: '완료', failed: '실패' }[state]}`;
      item.setAttribute('aria-hidden', 'true');
      chunks.append(item);
    }
    const stats = $('work-stats');
    stats.replaceChildren();
    const counts: [string, number, string][] = [
      ['완료', p.completed, 'complete'],
      ['진행', view.active, 'running'],
      ['대기', view.pending, 'pending'],
    ];
    if (p.failed) counts.push(['실패', p.failed, 'failed']);
    for (const [label, count, state] of counts) {
      const stat = document.createElement('span');
      stat.dataset['state'] = state;
      const value = document.createElement('strong');
      value.textContent = String(count);
      stat.append(label + ' ', value);
      stats.append(stat);
    }
    const jobs = $('work-jobs');
    jobs.replaceChildren();
    for (const job of p.jobs) {
      const li = document.createElement('li');
      li.textContent = `${job.label} — ${job.status}`;
      jobs.append(li);
    }
    const history = $('work-history');
    history.replaceChildren();
    for (const item of [...p.history].reverse().slice(0, 8)) {
      const li = document.createElement('li');
      const time = document.createElement('time');
      time.textContent = new Date(item.at).toLocaleTimeString('ko-KR', {
        hour: '2-digit',
        minute: '2-digit',
      });
      const text = document.createElement('span');
      text.textContent = item.text;
      li.append(time, text);
      history.append(li);
    }
    this.clock();
    return true;
  }
  setPreparation(p: Preparation): void {
    if (p.pdfSha256 !== this.sha || (this.preparation && p.updatedAt < this.preparation.updatedAt))
      return;
    this.preparation = p;
    $('preparation-message').textContent = p.message;
    const button = $('btn-preparation-refresh') as HTMLButtonElement;
    button.disabled = p.status === 'searching';
    button.textContent =
      p.status === 'searching' ? '찾는 중…' : p.status === 'idle' ? '자료 찾기' : '다시 찾기';
    const root = $('preparation-resources');
    root.replaceChildren();
    for (const resource of p.resources) {
      const article = document.createElement('article');
      article.className = 'preparation-resource';
      const meta = document.createElement('p');
      meta.className = 'resource-meta';
      meta.textContent = `${resource.kind === 'video' ? '영상' : '해설 글'} · ${resource.language} · ${resource.topic}`;
      const title = document.createElement('a');
      title.href = resource.url;
      title.target = '_blank';
      title.rel = 'noopener noreferrer';
      title.textContent = resource.title;
      const reason = document.createElement('p');
      reason.textContent = resource.reason;
      const proof = document.createElement('small');
      proof.textContent =
        resource.kind === 'video'
          ? '검색에서 확인한 영상 · 영상 내용은 확인하지 않았습니다'
          : resource.verified === 'viewed'
            ? '검색·열람 기록에서 확인한 글'
            : '검색에서 확인한 글 · 본문은 확인하지 않았습니다';
      article.append(meta, title, reason, proof);
      root.append(article);
    }
  }
  private clock(): void {
    const p = this.progress;
    if (!p) {
      $('process-time').textContent = '';
      return;
    }
    const elapsed = durationText((p.endedAt ?? Date.now()) - p.startedAt);
    $('work-clock').textContent = `이번 실행 ${elapsed}`;
    $('work-last').textContent = p.running
      ? `마지막 작업 응답 ${durationText(Date.now() - p.lastActivityAt)} 전`
      : '이번 실행 종료';
    $('process-time').textContent = p.running
      ? `${elapsed} 경과 · 마지막 응답 ${durationText(Date.now() - p.lastActivityAt)} 전`
      : '';
    $('work-waiting').hidden = !p.running || Date.now() - p.lastActivityAt < 90_000;
  }
}
