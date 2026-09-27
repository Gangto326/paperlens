import Ajv, { type ValidateFunction } from 'ajv';
import { formatAjvErrors, type Usage } from '@shared/schema';
import { AppServerError } from './app-server-client';
import { THREAD_APPROVAL_POLICY, TURN_SANDBOX_POLICY } from './codex-runtime';
import type { JsonValue } from './protocol/serde_json/JsonValue';
import type { AgentMessageDeltaNotification } from './protocol/v2/AgentMessageDeltaNotification';
import type { ItemCompletedNotification } from './protocol/v2/ItemCompletedNotification';
import type { ItemStartedNotification } from './protocol/v2/ItemStartedNotification';
import type { ThreadTokenUsageUpdatedNotification } from './protocol/v2/ThreadTokenUsageUpdatedNotification';
import type { TokenUsageBreakdown } from './protocol/v2/TokenUsageBreakdown';
import type { Turn } from './protocol/v2/Turn';
import type { TurnCompletedNotification } from './protocol/v2/TurnCompletedNotification';
import type { TurnError } from './protocol/v2/TurnError';
import type { TurnInterruptParams } from './protocol/v2/TurnInterruptParams';
import type { TurnStartParams } from './protocol/v2/TurnStartParams';
import type { TurnStartResponse } from './protocol/v2/TurnStartResponse';

/**
 * 구조화 출력 1턴 실행(COMMIT_PLAN C1.20). 도구 없는 스레드에서 `turn/start {outputSchema}`를 보내고
 * `turn/completed`까지 기다린 뒤 마지막 agent message를 JSON으로 읽어 같은 스키마로 검증한다.
 * App Server 0.157.1 실측(미로그인):
 * - `turn/start`는 곧바로 `{turn:{status:'inProgress'}}`로 응답하고 결과는 알림으로 온다
 *   (`turn/started` → `item/started`·`item/completed` → `turn/completed`).
 * - 미로그인이면 401로 재연결을 10회 시도한 뒤 약 17초 만에 `turn/completed status:'failed'`가 온다.
 *   그때 `codexErrorInfo`는 'unauthorized'가 아니라 'other'이고 메시지에만 "401 Unauthorized"가 있다.
 * 사용량은 `thread/tokenUsage/updated`의 `total`(스레드 누적)을 쓴다. 턴마다 새 스레드를 쓰는 것이 전제다.
 * 진행 이벤트와 사용자 중단(C2.1): `options.onProgress`로 턴 시작·항목·출력 글자 수·사용량을 알리고,
 * `options.signal`이 abort되면 `turn/interrupt`를 보낸 뒤 `turn/completed`를 `interruptGraceMs`만큼 기다린다.
 * 0.157.1 실측(로그인 상태): 출력 도중 `turn/interrupt`를 보내면 응답 `{}`와 `turn/completed status:'interrupted'`가
 * 약 10ms 안에 온다. 중단된 턴에는 진행 중이던 항목의 `item/completed`도 `thread/tokenUsage/updated`도 오지 않는다.
 * 그래서 중단된 턴의 토큰 값은 null이다. 제한 시간을 넘긴 턴은 `turn/interrupt`만 보내고 기다리지 않는다.
 * Codex 고유 타입은 이 파일 안에서만 쓴다.
 */
export interface TurnTransport {
  readonly state: 'running' | 'closing' | 'exited';
  request<T>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T>;
  onNotification(method: string, handler: (params: unknown) => void): () => void;
  onExit(handler: (info: { code: number | null; signal: string | null }) => void): () => void;
}

export type TurnFailureKind =
  | 'unavailable'
  | 'needs_login'
  | 'quota'
  | 'turn_failed'
  | 'interrupted'
  | 'cancelled'
  | 'no_output'
  | 'invalid_json'
  | 'schema_mismatch'
  | 'invalid_schema'
  | 'timeout'
  | 'transport';

export interface StructuredTurnParams {
  threadId: string;
  prompt: string;
  outputSchema: Record<string, unknown>;
  /** 턴 전체 제한 시간. 기본 120초. */
  timeoutMs?: number;
}

/** 턴 진행 알림. `chars`는 이 턴에서 받은 agent message delta의 누적 글자 수다. */
export type TurnProgress =
  | { type: 'started'; turnId: string }
  | {
      type: 'item';
      state: 'started' | 'completed';
      itemType: string;
      phase: string | null;
    }
  | { type: 'output'; chars: number }
  | { type: 'usage'; usage: Usage }
  | { type: 'interrupt_requested'; turnId: string };

export interface StructuredTurnOptions {
  log?: (line: string) => void;
  /** 진행 알림. 여기서 던진 예외는 로그만 남기고 턴에 영향을 주지 않는다. */
  onProgress?: (event: TurnProgress) => void;
  /** abort되면 턴을 중단한다. 이미 abort된 신호면 턴을 보내지 않는다. */
  signal?: AbortSignal;
  /** 중단 요청 뒤 `turn/completed`를 기다리는 시간. 기본 5초. */
  interruptGraceMs?: number;
}

export type StructuredTurnResult =
  | {
      ok: true;
      turnId: string;
      value: unknown;
      rawText: string;
      usage: Usage;
      /** 받은 thread/tokenUsage/updated 알림 수 */
      tokenUsageUpdates: number;
    }
  | {
      ok: false;
      kind: TurnFailureKind;
      message: string;
      /** 스키마 검증 오류 등 세부 항목 */
      errors: string[];
      turnId: string | null;
      rawText: string | null;
      usage: Usage;
      tokenUsageUpdates: number;
      /** kind가 cancelled일 때만. 서버가 `turn/completed status:'interrupted'`로 중단을 확인했는지. */
      interruptConfirmed?: boolean;
    };

export const DEFAULT_TURN_TIMEOUT_MS = 120_000;
export const DEFAULT_INTERRUPT_GRACE_MS = 5_000;

const QUOTA_ERRORS = new Set(['usageLimitExceeded', 'rateLimitExceeded', 'sessionBudgetExceeded']);

const httpStatusOf = (info: TurnError['codexErrorInfo']): number | null => {
  if (typeof info !== 'object' || info === null) return null;
  for (const value of Object.values(info)) {
    if (typeof value === 'object' && value !== null && 'httpStatusCode' in value) {
      const code = (value as { httpStatusCode: unknown }).httpStatusCode;
      if (typeof code === 'number') return code;
    }
  }
  return null;
};

/** 실패한 턴의 오류 → 앱의 실패 분류. 401은 메시지에만 드러나는 경우가 있어 문구도 본다(실측). */
export function classifyTurnError(error: TurnError | null): {
  kind: TurnFailureKind;
  message: string;
} {
  if (!error) return { kind: 'turn_failed', message: '턴이 실패했지만 오류 내용이 없습니다' };
  const info = error.codexErrorInfo;
  const message = error.message;
  if (
    info === 'unauthorized' ||
    httpStatusOf(info) === 401 ||
    /\b401\b\s*Unauthorized/i.test(message)
  ) {
    return { kind: 'needs_login', message };
  }
  if (typeof info === 'string' && QUOTA_ERRORS.has(info)) return { kind: 'quota', message };
  return { kind: 'turn_failed', message };
}

/** 스레드 누적 토큰 → Usage. 알림을 하나도 못 받았으면 토큰 값은 null이다. */
export function toUsage(
  total: TokenUsageBreakdown | null,
  elapsedMs: number,
  turnCount: number,
): Usage {
  return {
    logicalJobs: 1,
    turnCount,
    reportedModelCalls: null,
    inputTokens: total?.inputTokens ?? null,
    cachedInputTokens: total?.cachedInputTokens ?? null,
    outputTokens: total?.outputTokens ?? null,
    reasoningTokens: total?.reasoningOutputTokens ?? null,
    elapsedMs,
  };
}

export type ParsedOutput =
  | { ok: true; value: unknown }
  | { ok: false; kind: 'no_output' | 'invalid_json' | 'schema_mismatch'; errors: string[] };

/** 마지막 agent message를 JSON으로 읽고 스키마로 검증한다. 코드 펜스나 앞뒤 설명은 허용하지 않는다. */
export function parseStructuredOutput(
  text: string | null,
  validate: ValidateFunction,
): ParsedOutput {
  if (text === null || text.trim() === '') return { ok: false, kind: 'no_output', errors: [] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      kind: 'invalid_json',
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
  if (validate(value)) return { ok: true, value };
  return { ok: false, kind: 'schema_mismatch', errors: formatAjvErrors(validate.errors) };
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type Outcome =
  { type: 'completed'; turn: Turn } | { type: 'timeout' } | { type: 'exited'; detail: string };

const phaseOf = (item: { type: string }): string | null => {
  const phase = (item as { phase?: unknown }).phase;
  return typeof phase === 'string' ? phase : null;
};

export async function runStructuredTurn(
  transport: TurnTransport | null,
  params: StructuredTurnParams,
  options: StructuredTurnOptions = {},
): Promise<StructuredTurnResult> {
  const log = options.log ?? (() => undefined);
  const signal = options.signal;
  const emit = (event: TurnProgress): void => {
    if (!options.onProgress) return;
    try {
      options.onProgress(event);
    } catch (err) {
      log(`onProgress 예외: ${messageOf(err)}`);
    }
  };
  const t0 = Date.now();
  let turnId: string | null = null;
  let lastAgentText: string | null = null;
  let total: TokenUsageBreakdown | null = null;
  let tokenUsageUpdates = 0;
  let outputChars = 0;

  const fail = (
    kind: TurnFailureKind,
    message: string,
    errors: string[] = [],
  ): Extract<StructuredTurnResult, { ok: false }> => ({
    ok: false,
    kind,
    message,
    errors,
    turnId,
    rawText: lastAgentText,
    usage: toUsage(total, Date.now() - t0, turnId === null ? 0 : 1),
    tokenUsageUpdates,
  });

  if (!transport || transport.state !== 'running') {
    return fail('unavailable', 'LLM 런타임이 실행 중이 아닙니다');
  }
  if (signal?.aborted) {
    return { ...fail('cancelled', '턴을 보내기 전에 취소됐습니다'), interruptConfirmed: true };
  }
  let validate: ValidateFunction;
  try {
    // 호출자가 준 스키마라 알 수 없는 키워드가 있을 수 있다. 캐시 스키마용 strict 인스턴스와 따로 둔다.
    validate = new Ajv({ allErrors: true, strict: false }).compile(params.outputSchema);
  } catch (err) {
    return fail('invalid_schema', `출력 스키마를 컴파일할 수 없습니다: ${messageOf(err)}`);
  }

  const mine = (p: { threadId: string; turnId?: string }): boolean =>
    p.threadId === params.threadId &&
    (turnId === null || p.turnId === undefined || p.turnId === turnId);

  let settle: (outcome: Outcome) => void = () => undefined;
  const outcome = new Promise<Outcome>((resolve) => {
    settle = resolve;
  });
  const off = [
    transport.onNotification('item/started', (raw) => {
      const p = raw as ItemStartedNotification;
      if (!mine(p)) return;
      emit({ type: 'item', state: 'started', itemType: p.item.type, phase: phaseOf(p.item) });
    }),
    transport.onNotification('item/agentMessage/delta', (raw) => {
      const p = raw as AgentMessageDeltaNotification;
      if (!mine(p)) return;
      outputChars += p.delta.length;
      emit({ type: 'output', chars: outputChars });
    }),
    transport.onNotification('item/completed', (raw) => {
      const p = raw as ItemCompletedNotification;
      if (!mine(p)) return;
      if (p.item.type === 'agentMessage') lastAgentText = p.item.text;
      emit({ type: 'item', state: 'completed', itemType: p.item.type, phase: phaseOf(p.item) });
    }),
    transport.onNotification('thread/tokenUsage/updated', (raw) => {
      const p = raw as ThreadTokenUsageUpdatedNotification;
      if (!mine(p)) return;
      total = p.tokenUsage.total;
      tokenUsageUpdates += 1;
      emit({ type: 'usage', usage: toUsage(total, Date.now() - t0, 1) });
    }),
    transport.onNotification('turn/completed', (raw) => {
      const p = raw as TurnCompletedNotification;
      if (mine({ threadId: p.threadId, turnId: p.turn.id })) {
        settle({ type: 'completed', turn: p.turn });
      }
    }),
    transport.onExit((info) =>
      settle({
        type: 'exited',
        detail: `code=${String(info.code)} signal=${String(info.signal)}`,
      }),
    ),
  ];
  const timeoutMs = params.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const timer = setTimeout(() => settle({ type: 'timeout' }), timeoutMs);
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeCancel: () => void = () => undefined;
  const cancelRequested = new Promise<'cancel'>((resolve) => {
    wakeCancel = () => resolve('cancel');
  });
  signal?.addEventListener('abort', wakeCancel, { once: true });

  try {
    try {
      const res = await transport.request<TurnStartResponse>('turn/start', {
        threadId: params.threadId,
        input: [{ type: 'text', text: params.prompt, text_elements: [] }],
        outputSchema: params.outputSchema as JsonValue,
        sandboxPolicy: TURN_SANDBOX_POLICY,
        approvalPolicy: THREAD_APPROVAL_POLICY,
      } satisfies TurnStartParams);
      turnId = res.turn.id;
      emit({ type: 'started', turnId });
    } catch (err) {
      if (err instanceof AppServerError) {
        if (err.kind === 'timeout') return fail('timeout', err.message);
        if (err.kind === 'rpc') {
          const needsLogin = /authentication required|\b401\b/i.test(err.message);
          return fail(needsLogin ? 'needs_login' : 'turn_failed', err.message);
        }
      }
      return fail('transport', messageOf(err));
    }

    let result = await Promise.race([outcome, cancelRequested]);
    let cancelSent = false;
    if (result === 'cancel') {
      // 취소는 turn/start 응답을 받은 뒤에만 여기 온다. 그 전에 abort됐어도 turnId를 알아야 중단할 수 있다.
      cancelSent = true;
      log(`turn ${turnId} 취소 요청, turn/interrupt 전송`);
      emit({ type: 'interrupt_requested', turnId });
      void transport
        .request('turn/interrupt', {
          threadId: params.threadId,
          turnId,
        } satisfies TurnInterruptParams)
        .catch((err: unknown) => log(`turn/interrupt 실패: ${messageOf(err)}`));
      const graceMs = options.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS;
      const grace = new Promise<'unconfirmed'>((resolve) => {
        graceTimer = setTimeout(() => resolve('unconfirmed'), graceMs);
      });
      const after = await Promise.race([outcome, grace]);
      if (after === 'unconfirmed' || after.type === 'timeout') {
        return {
          ...fail('cancelled', `중단을 요청했지만 ${graceMs}ms 안에 턴 종료를 확인하지 못했습니다`),
          interruptConfirmed: false,
        };
      }
      result = after;
    }
    if (result.type === 'exited') {
      return fail('transport', `턴이 끝나기 전에 App Server가 종료됐습니다 (${result.detail})`);
    }
    if (result.type === 'timeout') {
      log(`turn ${turnId} 제한 시간 ${timeoutMs}ms 초과, 중단 요청`);
      void transport
        .request('turn/interrupt', {
          threadId: params.threadId,
          turnId,
        } satisfies TurnInterruptParams)
        .catch((err: unknown) => log(`turn/interrupt 실패: ${messageOf(err)}`));
      return fail('timeout', `턴이 ${timeoutMs}ms 안에 끝나지 않았습니다`);
    }

    const turn = result.turn;
    if (turn.status === 'interrupted') {
      if (cancelSent) {
        return { ...fail('cancelled', '요청에 따라 턴을 중단했습니다'), interruptConfirmed: true };
      }
      return fail('interrupted', '턴이 중단됐습니다');
    }
    // 취소를 보냈는데도 completed·failed로 끝났다면 중단보다 턴 종료가 먼저였다. 받은 결과를 그대로 쓴다.
    if (turn.status === 'failed') {
      const c = classifyTurnError(turn.error);
      return fail(c.kind, c.message);
    }
    if (turn.status !== 'completed') {
      return fail('turn_failed', `예상하지 않은 턴 상태 ${turn.status}`);
    }
    const parsed = parseStructuredOutput(lastAgentText, validate);
    if (!parsed.ok) {
      const messages: Record<typeof parsed.kind, string> = {
        no_output: '턴이 끝났지만 agent message가 없습니다',
        invalid_json: '최종 메시지가 JSON이 아닙니다',
        schema_mismatch: '최종 메시지가 출력 스키마와 맞지 않습니다',
      };
      return fail(parsed.kind, messages[parsed.kind], parsed.errors);
    }
    return {
      ok: true,
      turnId: turn.id,
      value: parsed.value,
      rawText: lastAgentText ?? '',
      usage: toUsage(total, Date.now() - t0, 1),
      tokenUsageUpdates,
    };
  } finally {
    clearTimeout(timer);
    if (graceTimer !== null) clearTimeout(graceTimer);
    signal?.removeEventListener('abort', wakeCancel);
    for (const unsubscribe of off) unsubscribe();
  }
}
