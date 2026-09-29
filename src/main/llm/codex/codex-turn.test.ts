import { afterEach, describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServerClient } from './app-server-client';
import { resolveCodexBinary, type CodexBinary } from './codex-binary';
import { CodexRuntime } from './codex-runtime';
import {
  classifyTurnError,
  parseStructuredOutput,
  runStructuredTurn,
  toUsage,
  type StructuredTurnResult,
} from './codex-turn';
import type { TurnError } from './protocol/v2/TurnError';

const FIXTURE = join(__dirname, '__fixtures__', 'fake-app-server.mjs');
const SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' }, n: { type: 'integer' } },
  required: ['answer', 'n'],
  additionalProperties: false,
};

const turnError = (over: Partial<TurnError>): TurnError => ({
  message: 'boom',
  codexErrorInfo: null,
  additionalDetails: null,
  misalignment: null,
  ...over,
});

describe('codex-turn 순수 부분', () => {
  it('classifyTurnError: 401은 코드·상태·문구 어느 쪽으로 와도 needs_login', () => {
    expect(classifyTurnError(turnError({ codexErrorInfo: 'unauthorized' })).kind).toBe(
      'needs_login',
    );
    expect(
      classifyTurnError(
        turnError({ codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } } }),
      ).kind,
    ).toBe('needs_login');
    // 0.157.1 실측: 최종 오류는 codexErrorInfo 'other'에 문구만 401이다.
    expect(
      classifyTurnError(
        turnError({
          codexErrorInfo: 'other',
          message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication',
        }),
      ).kind,
    ).toBe('needs_login');
  });

  it('classifyTurnError: 한도 계열은 quota, 나머지는 turn_failed', () => {
    expect(classifyTurnError(turnError({ codexErrorInfo: 'usageLimitExceeded' })).kind).toBe(
      'quota',
    );
    expect(classifyTurnError(turnError({ codexErrorInfo: 'rateLimitExceeded' })).kind).toBe(
      'quota',
    );
    expect(
      classifyTurnError(
        turnError({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } }),
      ).kind,
    ).toBe('turn_failed');
    expect(classifyTurnError(turnError({ codexErrorInfo: 'serverOverloaded' }))).toEqual({
      kind: 'turn_failed',
      message: 'boom',
    });
    expect(classifyTurnError(null).kind).toBe('turn_failed');
  });

  it('toUsage: 누적 토큰을 옮기고, 알림이 없었으면 토큰은 null', () => {
    expect(
      toUsage(
        {
          totalTokens: 1244,
          inputTokens: 1200,
          cachedInputTokens: 200,
          cacheWriteInputTokens: 0,
          outputTokens: 44,
          reasoningOutputTokens: 10,
        },
        1500,
        1,
      ),
    ).toEqual({
      logicalJobs: 1,
      turnCount: 1,
      reportedModelCalls: null,
      inputTokens: 1200,
      cachedInputTokens: 200,
      outputTokens: 44,
      reasoningTokens: 10,
      elapsedMs: 1500,
    });
    expect(toUsage(null, 10, 0)).toMatchObject({
      turnCount: 0,
      inputTokens: null,
      outputTokens: null,
    });
  });

  it('parseStructuredOutput: 없음·JSON 아님·스키마 불일치·통과', () => {
    const validate = new Ajv({ allErrors: true, strict: false }).compile(SCHEMA);
    expect(parseStructuredOutput(null, validate)).toEqual({
      ok: false,
      kind: 'no_output',
      errors: [],
    });
    expect(parseStructuredOutput('  ', validate)).toMatchObject({ kind: 'no_output' });
    expect(parseStructuredOutput('```json\n{"answer":"a","n":1}\n```', validate)).toMatchObject({
      ok: false,
      kind: 'invalid_json',
    });
    const mismatch = parseStructuredOutput('{"answer":"a","n":"3","extra":1}', validate);
    expect(mismatch).toMatchObject({ ok: false, kind: 'schema_mismatch' });
    if (!mismatch.ok) expect(mismatch.errors.length).toBe(2);
    expect(parseStructuredOutput('{"answer":"a","n":3}', validate)).toEqual({
      ok: true,
      value: { answer: 'a', n: 3 },
    });
  });
});

describe('runStructuredTurn (가짜 App Server)', () => {
  let client: AppServerClient | null = null;
  afterEach(async () => {
    await client?.close({ graceMs: 500, termMs: 500 });
    client = null;
  });

  const setup = async (): Promise<{ c: AppServerClient; threadId: string }> => {
    const child = spawn(process.execPath, [FIXTURE], { stdio: ['pipe', 'pipe', 'pipe'] });
    const c = new AppServerClient(child, { requestTimeoutMs: 5_000 });
    client = c;
    const res = await c.request<{ thread: { id: string } }>('thread/start', {});
    return { c, threadId: res.thread.id };
  };

  const run = async (prompt: string, timeoutMs = 3_000): Promise<StructuredTurnResult> => {
    const { c, threadId } = await setup();
    return runStructuredTurn(c, { threadId, prompt, outputSchema: SCHEMA, timeoutMs });
  };

  it('스키마대로 온 최종 메시지를 값으로 돌려주고 사용량을 기록한다', async () => {
    const result = await run('FAKE:reply {"answer":"hello","n":7}');
    expect(result).toMatchObject({
      ok: true,
      turnId: 'turn-1',
      value: { answer: 'hello', n: 7 },
      rawText: '{"answer":"hello","n":7}',
      tokenUsageUpdates: 1,
      usage: {
        logicalJobs: 1,
        turnCount: 1,
        inputTokens: 1200,
        cachedInputTokens: 200,
        outputTokens: 44,
        reasoningTokens: 10,
      },
    });
  });

  it('JSON이 아니거나 스키마와 다르면 실패로 분류하고 원문을 남긴다', async () => {
    expect(await run('FAKE:reply Sure! Here is the answer.')).toMatchObject({
      ok: false,
      kind: 'invalid_json',
      rawText: 'Sure! Here is the answer.',
    });
    await client?.close({ graceMs: 500, termMs: 500 });
    const mismatch = await run('FAKE:reply {"answer":"a"}');
    expect(mismatch).toMatchObject({ ok: false, kind: 'schema_mismatch', turnId: 'turn-1' });
    if (!mismatch.ok) expect(mismatch.errors.join(' ')).toContain('n');
  });

  it('조사 턴은 검색 기록을 돌려주고, 조사 턴이 아니면 검색 항목을 허용하지 않는다', async () => {
    const { c, threadId } = await setup();
    const result = await runStructuredTurn(c, {
      threadId,
      prompt: 'FAKE:search {"answer":"a","n":1}',
      outputSchema: SCHEMA,
      timeoutMs: 3_000,
      research: true,
    });
    expect(result).toMatchObject({
      ok: true,
      value: { answer: 'a', n: 1 },
      research: {
        queries: ['bm25 설명'],
        openRequests: ['https://example.org/bm25'],
        searchItems: 2,
        failedViews: 0,
        results: [
          { url: 'https://example.org/bm25', viewed: true },
          { url: 'https://video.example/watch?v=1', viewed: false },
        ],
      },
    });
    await client?.close({ graceMs: 500, termMs: 500 });
    const plain = await run('FAKE:search {"answer":"a","n":1}');
    expect(plain).toMatchObject({ ok: false, kind: 'forbidden_tool', errors: ['webSearch'] });
    await client?.close({ graceMs: 500, termMs: 500 });
    expect(await run('FAKE:reply {"answer":"a","n":1}')).toMatchObject({
      ok: true,
      research: null,
    });
  });

  it('조사 턴이라도 검색 말고 다른 도구 항목이 있으면 결과를 쓰지 않는다', async () => {
    const { c, threadId } = await setup();
    const result = await runStructuredTurn(c, {
      threadId,
      prompt: 'FAKE:shell {"answer":"a","n":1}',
      outputSchema: SCHEMA,
      timeoutMs: 3_000,
      research: true,
    });
    expect(result).toMatchObject({
      ok: false,
      kind: 'forbidden_tool',
      errors: ['commandExecution'],
      rawText: '{"answer":"a","n":1}',
    });
  });

  it('출력 도중 실패한 턴은 받은 데까지의 글을 돌려주고, 진행 알림에 조각을 싣는다', async () => {
    const { c, threadId } = await setup();
    const cut = '{"answer":"hel';
    const pieces: [number, string][] = [];
    const result = await runStructuredTurn(
      c,
      { threadId, prompt: `FAKE:cut ${cut}`, outputSchema: SCHEMA, timeoutMs: 3_000 },
      { onProgress: (e) => (e.type === 'output' ? pieces.push([e.item, e.delta]) : undefined) },
    );
    expect(result).toMatchObject({
      ok: false,
      kind: 'quota',
      // 끝난 메시지는 rawText에, 끝나지 못한 메시지는 partialText에 있다.
      rawText: 'Working on it.',
      partialText: cut,
      research: null,
    });
    expect(pieces[0]).toEqual([1, 'Working on it.']);
    expect(pieces.slice(1).every(([item]) => item === 2)).toBe(true);
    expect(
      pieces
        .slice(1)
        .map(([, delta]) => delta)
        .join(''),
    ).toBe(cut);
  });

  it('출력을 모두 받은 턴과 출력이 없던 턴의 partialText는 null', async () => {
    expect(await run('FAKE:reply Sure! Here is the answer.')).toMatchObject({
      ok: false,
      kind: 'invalid_json',
      partialText: null,
    });
    await client?.close({ graceMs: 500, termMs: 500 });
    expect(await run('FAKE:limit')).toMatchObject({ ok: false, partialText: null });
  });

  it('조사 턴이 도중에 실패해도 그때까지의 검색 기록을 돌려준다', async () => {
    const { c, threadId } = await setup();
    const seen: number[] = [];
    const result = await runStructuredTurn(
      c,
      {
        threadId,
        prompt: 'FAKE:searchcut {"answer":"a"',
        outputSchema: SCHEMA,
        timeoutMs: 3_000,
        research: true,
      },
      { onProgress: (e) => (e.type === 'research' ? seen.push(e.trace.searchItems) : undefined) },
    );
    // 검색 항목이 끝날 때마다 그때까지의 검색 기록을 알린다.
    expect(seen).toEqual([1, 2]);
    expect(result).toMatchObject({
      ok: false,
      kind: 'quota',
      partialText: '{"answer":"a"',
      research: {
        queries: ['bm25 설명'],
        searchItems: 2,
        results: [
          { url: 'https://example.org/bm25', viewed: true },
          { url: 'https://video.example/watch?v=1', viewed: false },
        ],
      },
    });
  });

  it('agent message 없이 끝나면 no_output', async () => {
    expect(await run('FAKE:silent')).toMatchObject({ ok: false, kind: 'no_output', rawText: null });
  });

  it('미로그인 401 실패는 needs_login, 한도 초과는 quota', async () => {
    expect(await run('아무 글')).toMatchObject({
      ok: false,
      kind: 'needs_login',
      usage: { turnCount: 1, inputTokens: null },
    });
    await client?.close({ graceMs: 500, termMs: 500 });
    expect(await run('FAKE:limit')).toMatchObject({ ok: false, kind: 'quota' });
  });

  it('turn/start가 오류면 turn_failed이고 턴 수는 0', async () => {
    expect(await run('FAKE:rpcfail')).toMatchObject({
      ok: false,
      kind: 'turn_failed',
      message: 'turn/start: thread not found',
      turnId: null,
      usage: { turnCount: 0 },
    });
  });

  it('제한 시간을 넘기면 timeout으로 끝내고 turn/interrupt를 보낸다', async () => {
    const { c, threadId } = await setup();
    const completed: unknown[] = [];
    c.onNotification('turn/completed', (p) => completed.push(p));
    const result = await runStructuredTurn(c, {
      threadId,
      prompt: 'FAKE:hang',
      outputSchema: SCHEMA,
      timeoutMs: 200,
    });
    expect(result).toMatchObject({ ok: false, kind: 'timeout', turnId: 'turn-1' });
    const end = Date.now() + 2_000;
    while (completed.length === 0 && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(completed[0]).toMatchObject({ turn: { id: 'turn-1', status: 'interrupted' } });
  });

  it('이미 취소된 신호면 턴을 보내지 않는다', async () => {
    const { c, threadId } = await setup();
    const started: unknown[] = [];
    c.onNotification('turn/started', (p) => started.push(p));
    const controller = new AbortController();
    controller.abort();
    const result = await runStructuredTurn(
      c,
      { threadId, prompt: 'FAKE:hang', outputSchema: SCHEMA },
      { signal: controller.signal },
    );
    expect(result).toMatchObject({
      ok: false,
      kind: 'cancelled',
      turnId: null,
      interruptConfirmed: true,
      usage: { turnCount: 0 },
    });
    await c.request('echo', {});
    expect(started).toEqual([]);
  });

  it('서버가 스스로 중단한 턴은 cancelled가 아니라 interrupted', async () => {
    const { c, threadId } = await setup();
    const running = runStructuredTurn(c, {
      threadId,
      prompt: 'FAKE:hang',
      outputSchema: SCHEMA,
      timeoutMs: 3_000,
    });
    await new Promise((r) => setTimeout(r, 50));
    await c.request('turn/interrupt', { threadId, turnId: 'turn-1' });
    expect(await running).toMatchObject({ ok: false, kind: 'interrupted' });
  });

  it('턴 도중 프로세스가 죽으면 transport', async () => {
    expect(await run('FAKE:crash')).toMatchObject({ ok: false, kind: 'transport' });
  });

  it('스키마를 컴파일할 수 없으면 턴을 보내지 않는다', async () => {
    const { c, threadId } = await setup();
    const result = await runStructuredTurn(c, {
      threadId,
      prompt: 'FAKE:reply {}',
      outputSchema: { type: 'nope' },
    });
    expect(result).toMatchObject({ ok: false, kind: 'invalid_schema', turnId: null });
  });

  it('transport가 없으면 unavailable', async () => {
    expect(
      await runStructuredTurn(null, { threadId: 't', prompt: 'x', outputSchema: SCHEMA }),
    ).toMatchObject({ ok: false, kind: 'unavailable', usage: { turnCount: 0 } });
  });
});

const binary: CodexBinary | null = (() => {
  try {
    return resolveCodexBinary();
  } catch {
    return null;
  }
})();

// api.openai.com에 (인증 없이) 접속하고 401 재시도로 약 17초가 걸려 기본 검사에서는 돌리지 않는다.
describe.skipIf(!binary || !process.env['PAPERLENS_LLM_SMOKE'])(
  'runStructuredTurn (실제 app-server, 미로그인)',
  () => {
    it('미로그인 턴은 needs_login으로 끝난다', async () => {
      const userData = await fs.mkdtemp(join(tmpdir(), 'paperlens-userdata-'));
      const rt = new CodexRuntime({ userDataPath: userData, appVersion: '0.0.0-test' });
      await rt.start();
      try {
        const thread = await rt.startThread();
        const result = await runStructuredTurn(rt.client, {
          threadId: thread.threadId,
          prompt: 'Return answer "paperlens-ok" and n 3.',
          outputSchema: SCHEMA,
          timeoutMs: 60_000,
        });
        expect(result).toMatchObject({ ok: false, kind: 'needs_login', usage: { turnCount: 1 } });
      } finally {
        await rt.stop();
      }
    }, 90_000);
  },
);
