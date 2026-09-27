import type { Usage } from '@shared/schema';

/**
 * LLM 어댑터의 앱 내부 계약 중 "구조화 작업 실행"과 "중단"(PLAN 4.2 표, COMMIT_PLAN C2.1).
 * 스케줄러·캐시·UI는 이 파일의 타입만 본다. 런타임 고유 값(스레드·턴 id, 프로토콜 알림)은 여기 나오지 않는다.
 */

/** 조사 정책. M2까지는 도구 없는 작업만 있다. 조사 도구가 붙는 정책은 M4에서 추가한다. */
export type LlmResearchPolicy = { kind: 'none' };

export interface LlmJobRequest {
  /** 호출자가 정하는 작업 ID. 실행 중인 작업과 같은 ID로는 시작할 수 없다. */
  jobId: string;
  prompt: string;
  outputSchema: Record<string, unknown>;
  research: LlmResearchPolicy;
  /** 역할 지침. 입력 데이터와 섞지 않고 따로 전달한다. */
  instructions?: string;
  /** 작업 전체 제한 시간. 없으면 어댑터 기본값. */
  timeoutMs?: number;
}

export type LlmJobFailureKind =
  | 'unavailable'
  | 'needs_login'
  | 'quota'
  | 'failed'
  | 'interrupted'
  | 'cancelled'
  | 'no_output'
  | 'invalid_json'
  | 'schema_mismatch'
  | 'invalid_schema'
  | 'timeout'
  | 'transport'
  | 'duplicate_job'
  | 'unsupported_policy';

export type LlmJobStage = 'thinking' | 'commentary' | 'answer' | 'other';

export type LlmJobEvent =
  | { type: 'started'; jobId: string; model: string | null }
  | { type: 'stage'; jobId: string; stage: LlmJobStage; state: 'started' | 'completed' }
  /** 지금까지 받은 출력 글자 수(누적). 출력 글 자체는 최종 검증 전이라 내보내지 않는다. */
  | { type: 'output'; jobId: string; chars: number }
  | { type: 'usage'; jobId: string; usage: Usage }
  | { type: 'cancel_requested'; jobId: string }
  | { type: 'finished'; jobId: string; outcome: 'ok' | LlmJobFailureKind; elapsedMs: number };

export type LlmJobResult =
  | { ok: true; jobId: string; value: unknown; rawText: string; model: string | null; usage: Usage }
  | {
      ok: false;
      jobId: string;
      kind: LlmJobFailureKind;
      message: string;
      errors: string[];
      /** 진단용 원래 출력. 받은 것이 없으면 null. */
      rawText: string | null;
      model: string | null;
      usage: Usage;
    };

export type LlmCancelResult =
  /** 중단을 요청했고 작업이 cancelled로 끝났다. confirmed는 런타임이 턴 종료를 알려 왔는지다. */
  | { jobId: string; status: 'cancelled'; confirmed: boolean }
  /** 중단보다 작업 종료가 먼저였다. outcome은 그 작업의 결과다. */
  | { jobId: string; status: 'already_finished'; outcome: 'ok' | LlmJobFailureKind }
  | { jobId: string; status: 'not_found' };

export interface LlmJobRunner {
  /** 던지지 않는다. 실패도 결과로 돌려준다. */
  run(request: LlmJobRequest, onEvent?: (event: LlmJobEvent) => void): Promise<LlmJobResult>;
  /** 작업이 끝난 것을 확인한 뒤 돌아온다. */
  cancel(jobId: string): Promise<LlmCancelResult>;
  activeJobIds(): string[];
}
