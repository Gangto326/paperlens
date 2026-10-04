import type { SchedulerEvent } from './paper-scheduler';

/** 이미 완료된 파일을 다시 여는 경우, 중단·실패에는 완료 알림을 내지 않는다. */
export function completionNotice(event: SchedulerEvent): { title: string; body: string } | null {
  if (event.type !== 'finished' || event.outcome.totalChunks === 0) return null;
  if (event.outcome.reason === 'complete')
    return {
      title: '번역이 완료됐습니다',
      body: `${event.outcome.completedChunks}개 구간의 번역과 해설을 읽을 수 있습니다.`,
    };
  if (event.outcome.reason === 'complete_with_gaps')
    return {
      title: '번역이 끝났습니다 · 일부 확인 필요',
      body: `${event.outcome.completedChunks}개 완료, ${event.outcome.failedChunks}개 구간 실패. 앱에서 이어서 번역할 수 있습니다.`,
    };
  return null;
}
