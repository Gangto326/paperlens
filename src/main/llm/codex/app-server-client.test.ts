import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { AppServerClient, AppServerError, type ExitInfo } from './app-server-client';

const FIXTURE = join(__dirname, '__fixtures__', 'fake-app-server.mjs');

function start(args: string[] = [], log?: (l: string) => void): AppServerClient {
  const child = spawn(process.execPath, [FIXTURE, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  return new AppServerClient(child, { requestTimeoutMs: 5_000, ...(log ? { log } : {}) });
}

const clients: AppServerClient[] = [];
const track = (c: AppServerClient): AppServerClient => {
  clients.push(c);
  return c;
};
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close({ graceMs: 500, termMs: 500 });
});

async function kindOf(p: Promise<unknown>): Promise<AppServerError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AppServerError) return err;
    throw err;
  }
  throw new Error('rejected 되지 않았다');
}

describe('AppServerClient', () => {
  it('요청·응답·알림·오류 응답을 주고받는다', async () => {
    const c = track(start());
    const pings: unknown[] = [];
    c.onNotification('test/ping', (params) => pings.push(params));
    const init = await c.request<{ ok: boolean; clientInfo: unknown }>('initialize', {
      clientInfo: { name: 'paperlens' },
    });
    expect(init.ok).toBe(true);
    expect(init.clientInfo).toEqual({ name: 'paperlens' });
    c.notify('initialized');
    expect(await c.request('echo', { a: 1 })).toEqual({ a: 1 });
    await c.request('notify');
    expect(pings).toEqual([{ n: 1 }]);
    const err = await kindOf(c.request('fail'));
    expect(err.kind).toBe('rpc');
    expect(err.code).toBe(-32600);
    expect(err.data).toEqual({ why: 'test' });
    expect(err.message).toContain('intentional failure');
  });

  it('서버→클라이언트 요청은 처리기가 없으면 -32601로 거절하고, 있으면 그 결과를 돌려준다', async () => {
    const c = track(start());
    const rejected = await c.request<{ clientReplied: { code: number } }>('serverRequest');
    expect(rejected.clientReplied.code).toBe(-32601);
    c.onServerRequest((req) => Promise.resolve({ seen: req.method }));
    const accepted = await c.request<{ clientReplied: unknown }>('serverRequest');
    expect(accepted.clientReplied).toEqual({ seen: 'item/tool/call' });
    c.onServerRequest(() => Promise.reject(new Error('no')));
    const thrown = await c.request<{ clientReplied: { code: number; message: string } }>(
      'serverRequest',
    );
    expect(thrown.clientReplied).toMatchObject({ code: -32601, message: 'no' });
  });

  it('응답이 없으면 제한 시간에 timeout으로 거절한다', async () => {
    const c = track(start());
    const err = await kindOf(c.request('slow', {}, { timeoutMs: 100 }));
    expect(err.kind).toBe('timeout');
    // 이후 요청은 정상
    expect(await c.request('echo', 1)).toBe(1);
  });

  it('크래시: 대기 요청은 exited로 거절, onExit는 expected=false와 stderr 꼬리를 전달', async () => {
    const c = track(start());
    let exit: ExitInfo | null = null;
    c.onExit((info) => {
      exit = info;
    });
    const slow = c.request('slow');
    const crash = c.request('crash');
    expect((await kindOf(slow)).kind).toBe('exited');
    expect((await kindOf(crash)).kind).toBe('exited');
    expect(c.state).toBe('exited');
    expect(exit).toMatchObject({ code: 3, signal: null, expected: false });
    expect((exit as unknown as ExitInfo).stderrTail).toContain('fake crash');
    expect((await kindOf(c.request('echo'))).kind).toBe('exited');
  });

  it('close(): stdin을 닫으면 정상 종료(expected=true, code 0)', async () => {
    const c = track(start());
    await c.request('initialize');
    const info = await c.close();
    expect(info).toMatchObject({ code: 0, signal: null, expected: true });
    expect(c.exitInfo).toBe(info);
    // 두 번 불러도 같은 결과
    expect(await c.close()).toBe(info);
  });

  it('close(): stdin을 닫아도 안 끝나면 SIGTERM으로 끝낸다', async () => {
    const logs: string[] = [];
    const c = track(start(['--ignore-stdin-close'], (l) => logs.push(l)));
    await c.request('initialize');
    const t0 = Date.now();
    const info = await c.close({ graceMs: 200, termMs: 2_000 });
    expect(info.expected).toBe(true);
    expect(info.signal).toBe('SIGTERM');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
    expect(logs.some((l) => l.includes('SIGTERM'))).toBe(true);
  });
});
