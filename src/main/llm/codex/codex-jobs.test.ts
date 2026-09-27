import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { LlmJobEvent, LlmJobRequest } from '../job';
import { AppServerClient } from './app-server-client';
import { CodexJobRunner, stageOf } from './codex-jobs';
import { CodexRuntime } from './codex-runtime';

const FIXTURE = join(__dirname, '__fixtures__', 'fake-app-server.mjs');
const SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' }, n: { type: 'integer' } },
  required: ['answer', 'n'],
  additionalProperties: false,
};
const LONG_REPLY = JSON.stringify({ answer: 'x'.repeat(2_000), n: 3 });

const job = (jobId: string, prompt: string, over: Partial<LlmJobRequest> = {}): LlmJobRequest => ({
  jobId,
  prompt,
  outputSchema: SCHEMA,
  research: { kind: 'none' },
  timeoutMs: 5_000,
  ...over,
});

const waitFor = async (cond: () => boolean, ms = 2_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error('조건을 기다리다 시간이 넘었습니다');
};

describe('stageOf', () => {
  it('항목 종류와 단계를 앱의 단계 이름으로 바꾼다', () => {
    expect(stageOf('userMessage', null)).toBeNull();
    expect(stageOf('reasoning', null)).toBe('thinking');
    expect(stageOf('agentMessage', 'commentary')).toBe('commentary');
    expect(stageOf('agentMessage', 'final_answer')).toBe('answer');
    expect(stageOf('agentMessage', null)).toBe('answer');
    expect(stageOf('mcpToolCall', null)).toBe('other');
  });
});

describe('CodexJobRunner (가짜 App Server)', () => {
  let client: AppServerClient | null = null;
  afterEach(async () => {
    await client?.close({ graceMs: 500, termMs: 500 });
    client = null;
  });

  const setup = (
    over: { interruptGraceMs?: number } = {},
  ): { runner: CodexJobRunner; c: AppServerClient; threads: unknown[] } => {
    const child = spawn(process.execPath, [FIXTURE], { stdio: ['pipe', 'pipe', 'pipe'] });
    const c = new AppServerClient(child, { requestTimeoutMs: 5_000 });
    client = c;
    const threads: unknown[] = [];
    const runner = new CodexJobRunner({
      transport: () => c,
      startThread: async (options) => {
        threads.push(options);
        const res = await c.request<{ thread: { id: string }; model: string }>('thread/start', {});
        return { threadId: res.thread.id, model: res.model };
      },
      ...over,
    });
    return { runner, c, threads };
  };

  it('작업 ID로 실행하면 진행 이벤트가 순서대로 오고 최종 JSON과 사용량을 돌려준다', async () => {
    const { runner, threads } = setup();
    const events: LlmJobEvent[] = [];
    const reply = '{"answer":"hello","n":7}';
    const result = await runner.run(
      job('job-a', `FAKE:stream ${reply}`, { instructions: '역할 지침' }),
      (e) => events.push(e),
    );
    expect(result).toMatchObject({
      ok: true,
      jobId: 'job-a',
      value: { answer: 'hello', n: 7 },
      rawText: reply,
      model: 'fake-model',
      usage: { logicalJobs: 1, turnCount: 1, inputTokens: 1200, outputTokens: 44 },
    });
    expect(threads).toEqual([{ developerInstructions: '역할 지침' }]);

    const outputs = events.filter((e) => e.type === 'output');
    expect(outputs.length).toBe(Math.ceil(reply.length / 4));
    expect(outputs.at(-1)).toEqual({ type: 'output', jobId: 'job-a', chars: reply.length });
    const shape = events
      .filter((e) => e.type !== 'output')
      .map((e) => (e.type === 'stage' ? `${e.type}:${e.stage}:${e.state}` : e.type));
    expect(shape).toEqual([
      'started',
      'stage:thinking:started',
      'stage:thinking:completed',
      'stage:answer:started',
      'stage:answer:completed',
      'usage',
      'finished',
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'finished', jobId: 'job-a', outcome: 'ok' });
    expect(runner.activeJobIds()).toEqual([]);
    // 런타임 고유 id는 결과와 이벤트 어디에도 없다.
    expect(JSON.stringify([result, events])).not.toMatch(/thread-1|turn-1/);
  });

  it('출력 도중 중단을 요청하면 턴이 실제로 멈춘다', async () => {
    const { runner, c } = setup();
    const events: LlmJobEvent[] = [];
    const completed: unknown[] = [];
    let deltas = 0;
    c.onNotification('turn/completed', (p) => completed.push(p));
    c.onNotification('item/agentMessage/delta', () => {
      deltas += 1;
    });
    const running = runner.run(job('job-b', `FAKE:stream ${LONG_REPLY}`), (e) => events.push(e));
    await waitFor(() => events.some((e) => e.type === 'output' && e.chars >= 12));
    expect(runner.activeJobIds()).toEqual(['job-b']);

    const cancel = await runner.cancel('job-b');
    expect(cancel).toEqual({ jobId: 'job-b', status: 'cancelled', confirmed: true });
    const result = await running;
    expect(result).toMatchObject({
      ok: false,
      jobId: 'job-b',
      kind: 'cancelled',
      rawText: null,
      // 중단된 턴에는 사용량 알림이 오지 않는다(실측).
      usage: { turnCount: 1, inputTokens: null },
    });
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ turn: { status: 'interrupted' } });

    // 서버가 출력을 멈췄는지: 중단 뒤에는 delta가 더 오지 않는다.
    const atCancel = deltas;
    expect(atCancel).toBeLessThan(LONG_REPLY.length / 4);
    await new Promise((r) => setTimeout(r, 150));
    expect(deltas).toBe(atCancel);
    expect(completed).toHaveLength(1);

    const types = events.map((e) => e.type);
    expect(types.indexOf('cancel_requested')).toBeGreaterThan(types.indexOf('started'));
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'cancelled' });
    expect(runner.activeJobIds()).toEqual([]);
    expect(await runner.cancel('job-b')).toEqual({
      jobId: 'job-b',
      status: 'already_finished',
      outcome: 'cancelled',
    });
  });

  it('턴이 시작되기 전에 온 중단 요청도 턴을 멈춘다', async () => {
    const { runner, c } = setup();
    const completed: unknown[] = [];
    c.onNotification('turn/completed', (p) => completed.push(p));
    const running = runner.run(job('job-c', 'FAKE:hang'));
    const cancel = await runner.cancel('job-c');
    expect(cancel.status).toBe('cancelled');
    expect(await running).toMatchObject({ ok: false, kind: 'cancelled' });
    // 스레드를 여는 중에 취소됐다면 턴을 보내지 않고, 이미 보냈다면 interrupted로 끝난다.
    for (const p of completed) expect(p).toMatchObject({ turn: { status: 'interrupted' } });
  });

  it('런타임이 중단을 확인해 주지 않으면 기다린 뒤 미확인으로 끝낸다', async () => {
    const { runner } = setup({ interruptGraceMs: 100 });
    const events: LlmJobEvent[] = [];
    const running = runner.run(job('job-d', 'FAKE:deaf'), (e) => events.push(e));
    await waitFor(() => events.some((e) => e.type === 'started'));
    const t0 = Date.now();
    expect(await runner.cancel('job-d')).toEqual({
      jobId: 'job-d',
      status: 'cancelled',
      confirmed: false,
    });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
    expect(await running).toMatchObject({ ok: false, kind: 'cancelled' });
  });

  it('모르는 작업 ID의 중단은 not_found, 끝난 작업은 already_finished', async () => {
    const { runner } = setup();
    expect(await runner.cancel('nope')).toEqual({ jobId: 'nope', status: 'not_found' });
    await runner.run(job('job-e', 'FAKE:reply {"answer":"a","n":1}'));
    expect(await runner.cancel('job-e')).toEqual({
      jobId: 'job-e',
      status: 'already_finished',
      outcome: 'ok',
    });
  });

  it('실행 중인 작업과 같은 ID는 거절하고 실행 중인 작업은 그대로 둔다', async () => {
    const { runner } = setup();
    const first = runner.run(job('job-f', 'FAKE:hang'));
    const events: LlmJobEvent[] = [];
    const second = await runner.run(job('job-f', 'FAKE:reply {"answer":"a","n":1}'), (e) =>
      events.push(e),
    );
    expect(second).toMatchObject({ ok: false, kind: 'duplicate_job', usage: { turnCount: 0 } });
    expect(events.map((e) => e.type)).toEqual(['finished']);
    expect(runner.activeJobIds()).toEqual(['job-f']);
    expect((await runner.cancel('job-f')).status).toBe('cancelled');
    expect(await first).toMatchObject({ ok: false, kind: 'cancelled' });
  });

  it('두 작업을 함께 돌려도 서로의 이벤트와 결과가 섞이지 않는다', async () => {
    const { runner } = setup();
    const seen: Record<string, Set<string>> = { x: new Set(), y: new Set() };
    const [x, y] = await Promise.all([
      runner.run(job('x', 'FAKE:stream {"answer":"from-x","n":1}'), (e) => seen['x']?.add(e.jobId)),
      runner.run(job('y', 'FAKE:stream {"answer":"from-y","n":2}'), (e) => seen['y']?.add(e.jobId)),
    ]);
    expect(x).toMatchObject({ ok: true, value: { answer: 'from-x', n: 1 } });
    expect(y).toMatchObject({ ok: true, value: { answer: 'from-y', n: 2 } });
    expect([...(seen['x'] ?? [])]).toEqual(['x']);
    expect([...(seen['y'] ?? [])]).toEqual(['y']);
  });

  it('실패 분류를 앱의 종류로 옮기고 진단용 원문을 남긴다', async () => {
    const { runner } = setup();
    expect(await runner.run(job('j1', 'FAKE:reply not json'))).toMatchObject({
      ok: false,
      kind: 'invalid_json',
      rawText: 'not json',
    });
    expect(await runner.run(job('j2', 'FAKE:limit'))).toMatchObject({ ok: false, kind: 'quota' });
    expect(await runner.run(job('j3', '지시어 없음'))).toMatchObject({
      ok: false,
      kind: 'needs_login',
    });
    expect(await runner.run(job('j4', 'FAKE:rpcfail'))).toMatchObject({
      ok: false,
      kind: 'failed',
    });
  });

  it('조사 정책이 none이 아니면 턴을 보내지 않는다', async () => {
    const { runner, threads } = setup();
    const request = { ...job('j5', 'FAKE:reply {}'), research: { kind: 'web' } };
    const result = await runner.run(request as unknown as LlmJobRequest);
    expect(result).toMatchObject({ ok: false, kind: 'unsupported_policy' });
    expect(threads).toEqual([]);
  });

  it('이벤트 처리기가 던져도 작업은 끝까지 간다', async () => {
    const { runner } = setup();
    const result = await runner.run(job('j6', 'FAKE:stream {"answer":"a","n":1}'), () => {
      throw new Error('boom');
    });
    expect(result).toMatchObject({ ok: true });
  });

  it('런타임이 없거나 스레드를 열 수 없으면 실패로 돌려준다', async () => {
    const none = new CodexJobRunner({
      transport: () => null,
      startThread: () => Promise.reject(new Error('unused')),
    });
    expect(await none.run(job('j7', 'x'))).toMatchObject({ ok: false, kind: 'unavailable' });
    const { c } = setup();
    const broken = new CodexJobRunner({
      transport: () => c,
      startThread: () => Promise.reject(new Error('thread/start: boom')),
    });
    expect(await broken.run(job('j8', 'x'))).toMatchObject({
      ok: false,
      kind: 'transport',
      message: '작업을 시작할 수 없습니다: thread/start: boom',
    });
  });
});

// 로그인된 실제 App Server로 중단을 확인한다. 한도를 쓰므로 기본 검사에서는 돌지 않는다.
// 실행: PAPERLENS_LLM_LIVE_USERDATA="$HOME/Library/Application Support/paperlens" npx vitest run src/main/llm/codex/codex-jobs.test.ts
const liveUserData = process.env['PAPERLENS_LLM_LIVE_USERDATA'];
describe.skipIf(!liveUserData)('CodexJobRunner (실제 app-server, 로그인 상태)', () => {
  it('출력 도중 중단하면 cancelled로 끝나고 중단이 확인된다', async () => {
    const userData = liveUserData ?? '';
    await fs.access(join(userData, 'codex-home', 'auth.json'));
    const rt = new CodexRuntime({ userDataPath: userData, appVersion: '0.0.0-test' });
    await rt.start();
    try {
      const runner = new CodexJobRunner({
        transport: () => rt.client,
        startThread: (options) => rt.startThread(options),
      });
      const events: LlmJobEvent[] = [];
      const running = runner.run(
        job(
          'live-cancel',
          'Set n to 3. Set answer to a 1200-word plain explanation of how PDF text extraction works.',
          { timeoutMs: 90_000 },
        ),
        (e) => events.push(e),
      );
      await waitFor(() => events.some((e) => e.type === 'output' && e.chars >= 20), 60_000);
      const t0 = Date.now();
      const cancel = await runner.cancel('live-cancel');
      const cancelMs = Date.now() - t0;
      const result = await running;
      const last = events.filter((e) => e.type === 'output').at(-1);
      console.log(
        `[live] cancel=${JSON.stringify(cancel)} cancelMs=${cancelMs} kind=${result.ok ? 'ok' : result.kind} chars=${last?.type === 'output' ? last.chars : 0} usage=${JSON.stringify(result.usage)}`,
      );
      expect(cancel).toEqual({ jobId: 'live-cancel', status: 'cancelled', confirmed: true });
      expect(result).toMatchObject({ ok: false, kind: 'cancelled' });
      expect(cancelMs).toBeLessThan(5_000);
    } finally {
      await rt.stop();
    }
  }, 120_000);
});
