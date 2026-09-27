import { join } from 'node:path';
import type { LlmAccountStatus } from '@shared/ipc';
import type { Usage } from '@shared/schema';
import { writeFileAtomic } from '../../cache/atomic-file';
import { runStructuredTurn, toUsage, type TurnFailureKind, type TurnTransport } from './codex-turn';

/**
 * 구조화 출력 스모크(COMMIT_PLAN C1.20, PLAN 4.2 표의 "기능 확인" 중 구조화 출력).
 * 도구 없는 새 스레드에서 작은 JSON Schema로 1턴을 돌리고, 결과와 Usage를 `userData/llm/structured-smoke.json`에 남긴다.
 * 한도를 쓰므로 자동으로 돌지 않는다. `PAPERLENS_LLM_SMOKE=1`로 앱을 띄웠을 때만 main이 호출한다.
 * 미로그인 턴은 401 재시도로 약 17초 뒤에야 실패하므로(실측) 턴을 보내기 전에 계정 상태를 먼저 본다.
 */
export const SMOKE_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    n: { type: 'integer' },
  },
  required: ['answer', 'n'],
  additionalProperties: false,
} as const;

export const SMOKE_EXPECTED = { answer: 'paperlens-ok', n: 3 } as const;

export const SMOKE_PROMPT =
  'Return a JSON object with "answer" set to the string "paperlens-ok" and "n" set to the integer 3. Do not use any tools.';

export const SMOKE_RECORD_VERSION = 1;

export interface StructuredSmokeRecord {
  schemaVersion: typeof SMOKE_RECORD_VERSION;
  checkedAt: string;
  runtimeVersion: string | null;
  model: string | null;
  ok: boolean;
  /** supported: 스키마대로 응답함. unsupported: 응답은 왔으나 스키마를 따르지 않음. unknown: 응답을 받지 못해 판단 불가. */
  structuredOutput: 'supported' | 'unsupported' | 'unknown';
  /** 요청한 값(answer·n)을 그대로 돌려줬는지. 스키마 통과와 별개인 참고 값이다. */
  echoMatched: boolean | null;
  failure: { kind: TurnFailureKind; message: string; errors: string[] } | null;
  threadId: string | null;
  turnId: string | null;
  tokenUsageUpdates: number;
  usage: Usage;
}

export interface StructuredSmokeDeps {
  transport: () => TurnTransport | null;
  readAccount: () => Promise<LlmAccountStatus>;
  startThread: () => Promise<{ threadId: string; model: string }>;
  runtimeVersion: string | null;
  timeoutMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

const UNSUPPORTED_KINDS = new Set<TurnFailureKind>([
  'no_output',
  'invalid_json',
  'schema_mismatch',
]);

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function runStructuredSmoke(
  deps: StructuredSmokeDeps,
): Promise<StructuredSmokeRecord> {
  const now = deps.now ?? (() => new Date());
  const t0 = Date.now();
  const base = {
    schemaVersion: SMOKE_RECORD_VERSION,
    checkedAt: now().toISOString(),
    runtimeVersion: deps.runtimeVersion,
  } as const;
  const notRun = (
    kind: TurnFailureKind,
    message: string,
    thread: { threadId: string; model: string } | null = null,
  ): StructuredSmokeRecord => ({
    ...base,
    model: thread?.model ?? null,
    ok: false,
    structuredOutput: 'unknown',
    echoMatched: null,
    failure: { kind, message, errors: [] },
    threadId: thread?.threadId ?? null,
    turnId: null,
    tokenUsageUpdates: 0,
    usage: toUsage(null, Date.now() - t0, 0),
  });

  const account = await deps.readAccount();
  if (account.state === 'unavailable') return notRun('unavailable', account.reason);
  if (account.state === 'needs_login') {
    return notRun('needs_login', 'ChatGPT 로그인이 필요합니다');
  }

  let thread: { threadId: string; model: string };
  try {
    thread = await deps.startThread();
  } catch (err) {
    return notRun('transport', `스레드를 시작할 수 없습니다: ${messageOf(err)}`);
  }

  const result = await runStructuredTurn(
    deps.transport(),
    {
      threadId: thread.threadId,
      prompt: SMOKE_PROMPT,
      outputSchema: SMOKE_SCHEMA,
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    },
    deps.log ? { log: deps.log } : {},
  );
  const common = {
    ...base,
    model: thread.model,
    threadId: thread.threadId,
    turnId: result.turnId,
    tokenUsageUpdates: result.tokenUsageUpdates,
    usage: result.usage,
  };
  if (!result.ok) {
    return {
      ...common,
      ok: false,
      structuredOutput: UNSUPPORTED_KINDS.has(result.kind) ? 'unsupported' : 'unknown',
      echoMatched: null,
      failure: { kind: result.kind, message: result.message, errors: result.errors },
    };
  }
  const value = result.value as { answer: string; n: number };
  return {
    ...common,
    ok: true,
    structuredOutput: 'supported',
    echoMatched: value.answer === SMOKE_EXPECTED.answer && value.n === SMOKE_EXPECTED.n,
    failure: null,
  };
}

export const smokeRecordPath = (userDataPath: string): string =>
  join(userDataPath, 'llm', 'structured-smoke.json');

export async function saveSmokeRecord(
  userDataPath: string,
  record: StructuredSmokeRecord,
): Promise<string> {
  const path = smokeRecordPath(userDataPath);
  await writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

const tokens = (n: number | null | undefined): string =>
  n === null || n === undefined ? '?' : String(n);

/** 로그용 한 줄 요약. */
export function formatSmokeRecord(record: StructuredSmokeRecord): string {
  const u = record.usage;
  const usage = `turns=${u.turnCount} in=${tokens(u.inputTokens)} cached=${tokens(u.cachedInputTokens)} out=${tokens(u.outputTokens)} reasoning=${tokens(u.reasoningTokens)} elapsed=${u.elapsedMs}ms`;
  if (record.ok) {
    return `smoke ok structuredOutput=supported echo=${String(record.echoMatched)} model=${record.model ?? '-'} ${usage}`;
  }
  const f = record.failure;
  return `smoke failed structuredOutput=${record.structuredOutput} kind=${f?.kind ?? '-'} (${f?.message ?? '-'})${
    f && f.errors.length > 0 ? ` errors=${f.errors.join('; ')}` : ''
  } ${usage}`;
}
