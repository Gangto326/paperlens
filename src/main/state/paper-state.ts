import type { PaperState } from '@shared/schema';
import type { LlmJobFailureKind } from '../llm/job';

/**
 * M2에서 쓰는 PaperState 전이(PLAN 8.2 enum, COMMIT_PLAN C2.3·C2.8).
 * - 1차 패스를 시작하면 `mapping` → `context_pending`. 컨텍스트가 저장돼도 `context_pending`에 머문다.
 *   `translating`으로 넘기는 것은 스케줄러(C2.8)다.
 * - 로그인이 필요하면 `needs_login`, 한도에 걸리면 `waiting_quota`. 둘 다 다시 1차 패스를 시작할 수 있다.
 * - 그 밖의 실패는 상태를 바꾸지 않고 manifest.errors에만 남긴다.
 */
export const CONTEXT_START_STATES: readonly PaperState[] = [
  'mapping',
  'context_pending',
  'needs_login',
  'waiting_quota',
];

export function canStartContextPass(state: PaperState): boolean {
  return CONTEXT_START_STATES.includes(state);
}

/** LLM 작업 실패 뒤의 상태. 바꿀 필요가 없으면 현재 상태를 돌려준다. */
export function stateAfterLlmFailure(current: PaperState, kind: LlmJobFailureKind): PaperState {
  if (kind === 'needs_login') return 'needs_login';
  if (kind === 'quota') return 'waiting_quota';
  return current;
}

const RETRYABLE: readonly LlmJobFailureKind[] = [
  'unavailable',
  'needs_login',
  'quota',
  'failed',
  'interrupted',
  'cancelled',
  'no_output',
  'invalid_json',
  'schema_mismatch',
  'timeout',
  'transport',
];

export function isRetryableLlmFailure(kind: LlmJobFailureKind): boolean {
  return RETRYABLE.includes(kind);
}
