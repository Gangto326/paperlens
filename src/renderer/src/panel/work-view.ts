import type { WorkProgress } from '@shared/work-status';

export const WORK_PHASES = [
  { key: 'context', label: '논문 전체 이해', detail: '연구의 질문과 전체 맥락을 읽습니다' },
  { key: 'research', label: '배경 자료 조사', detail: '이해에 필요한 근거 자료를 찾습니다' },
  { key: 'cards', label: '개념 설명 정리', detail: '핵심 용어와 개념을 연결합니다' },
  { key: 'translating', label: '문장 번역·해설', detail: '완료된 구간부터 바로 읽을 수 있습니다' },
] as const;

export function workView(p: WorkProgress) {
  const complete = p.state === 'complete';
  const active = p.running ? p.chunks.filter((c) => c.state === 'running').length : 0;
  const current =
    p.phase === 'finished' ? (p.total ? 3 : 0) : WORK_PHASES.findIndex((v) => v.key === p.phase);
  const phase = WORK_PHASES[current]!;
  const title = p.running
    ? `${phase.label} 중`
    : complete
      ? '논문을 읽을 준비가 됐습니다'
      : ((
          {
            waiting_quota: '사용 한도가 풀리기를 기다립니다',
            needs_login: '로그인 후 이어서 할 수 있습니다',
            complete_with_gaps: '일부 구간을 다시 확인해 주세요',
            failed: '작업을 완료하지 못했습니다',
          } as Record<string, string>
        )[p.state ?? ''] ?? '번역을 잠시 멈췄습니다');
  return {
    title,
    badge: p.running ? '진행 중' : complete ? '완료' : '대기 중',
    description: p.running
      ? phase.detail
      : complete
        ? '모든 번역과 해설을 저장했습니다. 원문에서 문장을 선택해 읽어 보세요.'
        : '완료된 내용은 저장했습니다. 이어서 번역하면 남은 작업을 진행합니다.',
    active,
    pending: Math.max(0, p.total - p.completed - p.failed - active),
    percent: p.total ? Math.floor((100 * p.completed) / p.total) : null,
    steps: WORK_PHASES.map((phase, i) => ({
      ...phase,
      state:
        complete || i < current
          ? 'done'
          : i === current
            ? p.running
              ? 'current'
              : 'paused'
            : 'pending',
      status:
        complete || i < current
          ? '완료'
          : i === current
            ? p.running
              ? '진행 중'
              : '멈춤'
            : '대기',
    })),
  };
}
