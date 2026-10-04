import { expect, it } from 'vitest';
import type { WorkProgress } from '@shared/work-status';
import { workView } from './work-view';

const progress: WorkProgress = {
  pdfSha256: 'a'.repeat(64),
  revision: 1,
  running: true,
  phase: 'translating',
  state: 'translating',
  startedAt: 0,
  endedAt: null,
  lastActivityAt: 0,
  step: null,
  completed: 1,
  failed: 1,
  total: 4,
  chunks: [
    { id: 'a', index: 0, state: 'complete' },
    { id: 'b', index: 1, state: 'failed' },
    { id: 'c', index: 2, state: 'running' },
    { id: 'd', index: 3, state: 'pending' },
  ],
  jobs: [],
  history: [],
};
it('실패·진행 구간을 완료율에 넣지 않는다', () => {
  expect(workView(progress)).toMatchObject({ percent: 25, active: 1, pending: 1 });
});
it('멈춘 단계 뒤의 작업을 완료로 표시하지 않는다', () => {
  const view = workView({ ...progress, running: false, phase: 'research', state: 'paused' });
  expect(view.active).toBe(0);
  expect(view.steps.map((s) => s.state)).toEqual(['done', 'paused', 'pending', 'pending']);
});
it('총 구간을 모르는 준비 단계에는 백분율을 만들지 않는다', () => {
  expect(workView({ ...progress, phase: 'context', total: 0 }).percent).toBeNull();
});
