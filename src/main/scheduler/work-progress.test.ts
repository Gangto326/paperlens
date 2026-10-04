import { describe, expect, it } from 'vitest';
import type { WorkProgress } from '@shared/work-status';
import type { LlmJobRunner } from '../llm/job';
import { WorkProgressTracker } from './work-progress';
import { completionNotice } from './completion-notification';
import type { SchedulerEvent, RunOutcome } from './paper-scheduler';
const sha = 'a'.repeat(64);
const outcome = (reason: RunOutcome['reason']): RunOutcome => ({
  reason,
  message: null,
  generationId: 'g',
  totalChunks: 3,
  completedChunks: 2,
  failedChunks: 1,
  metrics: [],
  contextUsage: null,
  researchUsage: null,
  researchBatches: [],
  cardsUsage: null,
  firstTranslationMs: null,
  elapsedMs: 1000,
});

describe('실제 처리 진행', () => {
  it('병렬 구간을 독립적으로 표시하고 실패를 완료 개수에 넣지 않는다', () => {
    const tracker = new WorkProgressTracker(() => {});
    tracker.handle({ type: 'started', pdfSha256: sha });
    tracker.handle({ type: 'plan', pdfSha256: sha, generationId: 'g', chunkIds: ['a', 'b', 'c'] });
    for (const [index, chunkId] of ['a', 'b'].entries())
      tracker.handle({ type: 'chunk_started', pdfSha256: sha, chunkId, index, total: 3 });
    tracker.handle({
      type: 'chunk_finished',
      pdfSha256: sha,
      chunkId: 'b',
      ok: false,
      completed: 0,
      failed: 1,
      total: 3,
      sentenceIds: [],
    });
    expect(tracker.read(sha)).toMatchObject({
      completed: 0,
      failed: 1,
      chunks: [{ state: 'running' }, { state: 'failed' }, { state: 'pending' }],
    });
    tracker.fail(sha, '오류');
    expect(tracker.read(sha)).toMatchObject({ running: false, state: 'failed' });
  });
  it('모델의 검증 전 출력은 노출하지 않고 카드 단계와 응답 시각만 기록한다', async () => {
    const events: WorkProgress[] = [];
    let time = 1000;
    const tracker = new WorkProgressTracker(
      (p) => events.push(p),
      () => time,
    );
    tracker.handle({ type: 'started', pdfSha256: sha });
    const inner: LlmJobRunner = {
      run: (request, onEvent) => {
        time = 4000;
        onEvent?.({
          type: 'output',
          jobId: request.jobId,
          chars: 100,
          item: 1,
          delta: 'PRIVATE UNVALIDATED TEXT',
        });
        tracker.retry(sha, request.jobId, 1, 5000);
        return Promise.resolve({
          ok: true,
          jobId: request.jobId,
          value: {},
          rawText: '{}',
          model: null,
          usage: { logicalJobs: 1, turnCount: 1, elapsedMs: 100, inputTokens: 0, outputTokens: 0 },
        });
      },
      cancel: (id) => Promise.resolve({ jobId: id, status: 'not_found' }),
      activeJobIds: () => [],
    };
    await tracker
      .wrap(inner, () => sha)
      .run({ jobId: 'cc_1', prompt: '', outputSchema: {}, research: { kind: 'none' } });
    expect(tracker.read(sha)).toMatchObject({
      phase: 'cards',
      startedAt: 1000,
      lastActivityAt: 4000,
      jobs: [],
    });
    expect(JSON.stringify(events)).not.toContain('PRIVATE');
    expect(events.some((p) => p.history.some((h) => h.text.includes('재시도')))).toBe(true);
  });
  it('새 실행의 타이머는 초기화하고 변경 순번은 유지한다', () => {
    let time = 10;
    const tracker = new WorkProgressTracker(
      () => {},
      () => time,
    );
    tracker.handle({ type: 'started', pdfSha256: sha });
    const revision = tracker.read(sha)!.revision;
    time = 99;
    tracker.handle({ type: 'started', pdfSha256: sha });
    expect(tracker.read(sha)!.startedAt).toBe(99);
    expect(tracker.read(sha)!.revision).toBeGreaterThan(revision);
  });
});
describe('완료 알림 조건', () => {
  it('완료·일부 실패를 구별하며 멈춤과 캐시 재열기는 알리지 않는다', () => {
    const event = (reason: RunOutcome['reason']): SchedulerEvent => ({
      type: 'finished',
      pdfSha256: sha,
      state: 'complete',
      outcome: outcome(reason),
    });
    expect(completionNotice(event('complete'))?.title).toBe('번역이 완료됐습니다');
    expect(completionNotice(event('complete_with_gaps'))?.title).toContain('일부 확인');
    expect(completionNotice(event('paused'))).toBeNull();
    expect(
      completionNotice({
        type: 'finished',
        pdfSha256: sha,
        state: 'complete',
        outcome: { ...outcome('complete'), totalChunks: 0 },
      }),
    ).toBeNull();
  });
});
