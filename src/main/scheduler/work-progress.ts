import type { WorkProgress } from '@shared/work-status';
import type { LlmJobEvent, LlmJobRunner } from '../llm/job';
import type { SchedulerEvent } from './paper-scheduler';

/** 실제 이벤트만 기록한다. 시간 경과를 진행률로 바꾸거나 생성 중인 원문/추론을 노출하지 않는다. */
export class WorkProgressTracker {
  private readonly papers = new Map<string, WorkProgress>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(
    private readonly publish: (value: WorkProgress) => void,
    private readonly now = Date.now,
  ) {}
  read(sha: string): WorkProgress | null {
    return structuredClone(this.papers.get(sha) ?? null);
  }
  forget(sha: string): void {
    clearTimeout(this.timers.get(sha));
    this.timers.delete(sha);
    this.papers.delete(sha);
  }
  private changed(p: WorkProgress, immediate = false): void {
    p.revision++;
    p.lastActivityAt = this.now();
    if (!immediate && this.timers.has(p.pdfSha256)) return;
    if (immediate) {
      clearTimeout(this.timers.get(p.pdfSha256));
      this.timers.delete(p.pdfSha256);
      this.publish(structuredClone(p));
    } else {
      const timer = setTimeout(() => {
        this.timers.delete(p.pdfSha256);
        this.publish(structuredClone(p));
      }, 700);
      timer.unref();
      this.timers.set(p.pdfSha256, timer);
    }
  }
  private note(p: WorkProgress, text: string): void {
    p.history.push({ at: this.now(), text });
    p.history = p.history.slice(-20);
  }
  handle(event: SchedulerEvent): void {
    const sha = event.pdfSha256;
    if (event.type === 'started') {
      const p: WorkProgress = {
        pdfSha256: sha,
        revision: (this.papers.get(sha)?.revision ?? 0) + 1,
        running: true,
        startedAt: this.now(),
        endedAt: null,
        lastActivityAt: this.now(),
        phase: 'context',
        state: null,
        step: null,
        completed: 0,
        failed: 0,
        total: 0,
        chunks: [],
        jobs: [],
        history: [],
      };
      this.papers.set(sha, p);
      this.note(p, '번역 준비를 시작했습니다.');
      this.changed(p, true);
      return;
    }
    const p = this.papers.get(sha);
    if (!p) return;
    switch (event.type) {
      case 'state':
        p.state = event.state;
        break;
      case 'context':
        p.phase = 'context';
        p.step = event.progress ?? null;
        if (!event.progress)
          this.note(
            p,
            event.status === 'running'
              ? '논문의 전체 맥락을 읽고 있습니다.'
              : event.status === 'failed'
                ? '논문 이해 단계가 중단됐습니다.'
                : '논문 개요가 준비됐습니다.',
          );
        break;
      case 'research':
        p.phase = 'research';
        p.step = event.progress ?? null;
        if (!event.progress)
          this.note(
            p,
            event.status === 'running'
              ? '배경 개념과 근거 자료를 조사하고 있습니다.'
              : event.status === 'done'
                ? `개념 ${event.researched}개 · 출처 ${event.sources}개를 정리했습니다.`
                : '추가 조사를 마치고 가능한 자료로 계속합니다.',
          );
        break;
      case 'plan':
        p.phase = 'translating';
        p.step = null;
        p.total = event.chunkIds.length;
        p.chunks = event.chunkIds.map((id, index) => ({ id, index, state: 'pending' }));
        this.note(p, `${p.total}개 구간의 번역·해설을 시작합니다.`);
        break;
      case 'chunk_started': {
        const c = p.chunks.find((c) => c.id === event.chunkId);
        if (c) c.state = 'running';
        break;
      }
      case 'chunk_finished': {
        p.completed = event.completed;
        p.failed = event.failed;
        p.total = event.total;
        const c = p.chunks.find((c) => c.id === event.chunkId);
        if (c) c.state = event.ok ? 'complete' : 'failed';
        this.note(
          p,
          `${(c?.index ?? 0) + 1}번 구간 ${event.ok ? '저장 완료' : '처리 실패'} · ${event.sentenceIds.length}문장`,
        );
        break;
      }
      case 'finished':
        p.running = false;
        if (event.state === 'complete') p.phase = 'finished';
        p.endedAt = this.now();
        p.state = event.state;
        p.jobs = [];
        this.note(
          p,
          event.outcome.reason === 'complete'
            ? '모든 번역과 해설이 준비됐습니다.'
            : (event.outcome.message ??
                (event.outcome.reason === 'complete_with_gaps'
                  ? '일부 구간이 실패했습니다. 이어서 번역할 수 있습니다.'
                  : '처리가 중단됐습니다.')),
        );
        break;
    }
    this.changed(p, true);
  }
  fail(sha: string, message: string): void {
    const p = this.papers.get(sha);
    if (!p) return;
    p.running = false;
    p.state = 'failed';
    p.endedAt = this.now();
    p.jobs = [];
    this.note(p, message);
    this.changed(p, true);
  }
  retry(sha: string | null, jobId: string, attempt: number, delayMs: number): void {
    const p = sha ? this.papers.get(sha) : null;
    if (!p || !p.running) return;
    const job = p.jobs.find((j) => j.id === jobId);
    if (job) job.status = `${Math.ceil(delayMs / 1000)}초 후 재시도`;
    this.note(
      p,
      `일시적인 응답 오류로 ${Math.ceil(delayMs / 1000)}초 뒤 ${attempt}차 재시도를 합니다.`,
    );
    this.changed(p, true);
  }
  wrap(inner: LlmJobRunner, current: () => string | null): LlmJobRunner {
    return {
      run: async (request, onEvent) => {
        const sha = current();
        const p = sha ? this.papers.get(sha) : null;
        if (p?.running) {
          const label = request.jobId.startsWith('cc_')
            ? '개념 설명 작성'
            : request.jobId.startsWith('tr_')
              ? '문장 번역·해설'
              : request.research.kind === 'builtin_web'
                ? '근거 자료 조사'
                : '논문 이해';
          if (request.jobId.startsWith('cc_')) {
            p.phase = 'cards';
            p.step = null;
          }
          p.jobs.push({ id: request.jobId, label, status: '응답 대기', startedAt: this.now() });
          this.changed(p, true);
        }
        const observe = (event: LlmJobEvent): void => {
          if (p?.running) {
            const job = p.jobs.find((j) => j.id === request.jobId);
            if (job) {
              if (event.type === 'stage')
                job.status = event.stage === 'answer' ? '결과 작성 중' : '모델 처리 중';
              if (event.type === 'output') job.status = '결과 수신 중';
              if (event.type === 'research')
                job.status = `검색 ${event.trace.searchItems}회 · 후보 ${event.trace.results.length}개`;
              this.changed(p);
            }
          }
          onEvent?.(event);
        };
        try {
          return await inner.run(request, observe);
        } finally {
          if (p) {
            p.jobs = p.jobs.filter((j) => j.id !== request.jobId);
            this.changed(p, true);
          }
        }
      },
      cancel: (id) => inner.cancel(id),
      activeJobIds: () => inner.activeJobIds(),
    };
  }
}
