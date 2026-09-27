import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmAccountEvent } from '@shared/ipc';
import { AppServerClient, AppServerError } from './app-server-client';
import {
  CodexAccount,
  formatAccountStatus,
  formatRateLimits,
  rateLimitsFromError,
  resetsAtToIso,
  toAccountStatus,
  toRateLimits,
} from './codex-account';
import { resolveCodexBinary, type CodexBinary } from './codex-binary';
import { CodexRuntime } from './codex-runtime';
import type { RateLimitSnapshot } from './protocol/v2/RateLimitSnapshot';

const FIXTURE = join(__dirname, '__fixtures__', 'fake-app-server.mjs');
const NOW = new Date('2026-09-27T00:00:00Z');

const snapshot = (over: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot => ({
  limitId: null,
  limitName: null,
  normalModelSlug: null,
  primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_790_500_000 },
  secondary: null,
  credits: null,
  individualLimit: null,
  spendControlReached: null,
  planType: 'plus',
  rateLimitReachedType: null,
  ...over,
});

describe('CodexAccount 순수 변환', () => {
  it('toAccountStatus: 계정 없음 → needs_login, chatgpt/apiKey/기타 → authenticated', () => {
    expect(toAccountStatus({ account: null, requiresOpenaiAuth: true })).toEqual({
      state: 'needs_login',
    });
    expect(
      toAccountStatus({
        account: { type: 'chatgpt', email: 'a@b.c', planType: 'pro' },
        requiresOpenaiAuth: false,
      }),
    ).toEqual({ state: 'authenticated', method: 'chatgpt', email: 'a@b.c', plan: 'pro' });
    expect(toAccountStatus({ account: { type: 'apiKey' }, requiresOpenaiAuth: false })).toEqual({
      state: 'authenticated',
      method: 'api_key',
      email: null,
      plan: null,
    });
    expect(
      toAccountStatus({
        account: { type: 'amazonBedrock', usesCodexManagedCredentials: false },
        requiresOpenaiAuth: false,
      }),
    ).toMatchObject({ state: 'authenticated', method: 'other' });
  });

  it('resetsAtToIso: 초 단위 기본, 1e12 이상은 밀리초, null·비유한값은 null', () => {
    expect(resetsAtToIso(1_790_500_000)).toBe('2026-09-27T09:06:40.000Z');
    expect(resetsAtToIso(1_790_500_000_000)).toBe('2026-09-27T09:06:40.000Z');
    expect(resetsAtToIso(null)).toBeNull();
    expect(resetsAtToIso(Number.NaN)).toBeNull();
  });

  it('toRateLimits: 창·요금제·조회 시각을 옮기고 없는 창은 null', () => {
    expect(toRateLimits(snapshot(), NOW)).toEqual({
      available: true,
      primary: { usedPercent: 12, windowMinutes: 300, resetsAt: '2026-09-27T09:06:40.000Z' },
      secondary: null,
      plan: 'plus',
      readAt: NOW.toISOString(),
    });
    const empty = toRateLimits(snapshot({ primary: null, planType: null }), NOW);
    expect(empty).toMatchObject({ available: true, primary: null, secondary: null, plan: null });
  });

  it('rateLimitsFromError: 인증 필요 rpc 오류는 needs_login, 그 외는 error', () => {
    expect(
      rateLimitsFromError(
        new AppServerError(
          'rpc',
          'codex account authentication required to read rate limits',
          -32600,
        ),
      ),
    ).toEqual({
      available: false,
      reason: 'needs_login',
      message: 'codex account authentication required to read rate limits',
    });
    expect(rateLimitsFromError(new AppServerError('rpc', 'boom', -32600))).toMatchObject({
      available: false,
      reason: 'error',
    });
    expect(rateLimitsFromError(new AppServerError('timeout', 'slow'))).toMatchObject({
      reason: 'error',
      message: 'slow',
    });
    expect(rateLimitsFromError('x')).toEqual({ available: false, reason: 'error', message: 'x' });
  });

  it('format*: 로그 한 줄', () => {
    expect(formatAccountStatus({ state: 'needs_login' })).toBe('account needs_login');
    expect(formatAccountStatus({ state: 'unavailable', reason: 'r' })).toBe(
      'account unavailable (r)',
    );
    expect(
      formatAccountStatus({ state: 'authenticated', method: 'chatgpt', email: null, plan: 'plus' }),
    ).toBe('account authenticated method=chatgpt email=- plan=plus');
    expect(formatRateLimits(toRateLimits(snapshot(), NOW))).toBe(
      'rateLimits primary=12%/300min resets=2026-09-27T09:06:40.000Z secondary=? plan=plus',
    );
    expect(formatRateLimits({ available: false, reason: 'needs_login', message: 'm' })).toBe(
      'rateLimits unavailable (needs_login: m)',
    );
  });

  it('transport가 없으면 모든 조회가 unavailable이고 로그인은 시작되지 않는다', async () => {
    const acc = new CodexAccount(() => null);
    expect(await acc.read()).toEqual({
      state: 'unavailable',
      reason: 'LLM 런타임이 실행 중이 아닙니다',
    });
    expect(await acc.readRateLimits()).toMatchObject({ available: false, reason: 'unavailable' });
    expect(await acc.startLogin()).toMatchObject({ started: false });
    expect(await acc.cancelLogin('x')).toBe('unavailable');
  });
});

describe('CodexAccount (가짜 App Server)', () => {
  let client: AppServerClient | null = null;
  afterEach(async () => {
    await client?.close({ graceMs: 500, termMs: 500 });
    client = null;
  });

  const setup = (): { acc: CodexAccount; events: LlmAccountEvent[]; c: AppServerClient } => {
    const child = spawn(process.execPath, [FIXTURE], { stdio: ['pipe', 'pipe', 'pipe'] });
    const c = new AppServerClient(child, { requestTimeoutMs: 5_000 });
    client = c;
    const acc = new CodexAccount(() => c, { now: () => NOW });
    const events: LlmAccountEvent[] = [];
    acc.onEvent((e) => events.push(e));
    acc.attach();
    return { acc, events, c };
  };

  const waitFor = async (pred: () => boolean, ms = 3_000): Promise<void> => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error('시간 초과');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('미로그인 → 로그인 시작 → 완료 알림 → authenticated·한도 갱신 → 로그아웃', async () => {
    const { acc, events, c } = setup();
    expect(await acc.read()).toEqual({ state: 'needs_login' });
    expect(await acc.readRateLimits()).toMatchObject({ available: false, reason: 'needs_login' });

    const start = await acc.startLogin();
    expect(start).toEqual({
      started: true,
      loginId: 'login-1',
      authUrl: 'https://auth.example.test/oauth/authorize?state=login-1',
    });
    // 브라우저 인증이 끝난 것처럼 서버가 완료 알림을 보낸다.
    await c.request('test/completeLogin', { loginId: 'login-1', success: true });
    await waitFor(() => events.some((e) => e.type === 'loginCompleted'));
    expect(events.find((e) => e.type === 'loginCompleted')).toEqual({
      type: 'loginCompleted',
      result: { loginId: 'login-1', success: true, error: null },
    });
    // 완료 후 재조회(계정 → 한도)와 서버 알림(account/updated → 재조회, rateLimits/updated)이 상태를 확정한다.
    await waitFor(
      () => acc.lastStatus.state === 'authenticated' && acc.lastRateLimits.available === true,
    );
    expect(acc.lastStatus).toEqual({
      state: 'authenticated',
      method: 'chatgpt',
      email: 'user@example.com',
      plan: 'plus',
    });
    expect(acc.lastRateLimits).toEqual({
      available: true,
      primary: { usedPercent: 12, windowMinutes: 300, resetsAt: '2026-09-27T09:06:40.000Z' },
      secondary: { usedPercent: 3, windowMinutes: 10_080, resetsAt: null },
      plan: 'plus',
      readAt: NOW.toISOString(),
    });
    expect(await acc.readRateLimits()).toMatchObject({ available: true });

    expect(await acc.logout()).toEqual({ state: 'needs_login' });
    expect(acc.lastRateLimits).toMatchObject({ available: false, reason: 'needs_login' });
    expect(await acc.readRateLimits()).toMatchObject({ available: false, reason: 'needs_login' });
  });

  it('취소: 진행 중 loginId는 canceled + 실패 완료 알림, 지난 id는 not_found, 엉뚱한 id도 not_found', async () => {
    const { acc, events } = setup();
    const start = await acc.startLogin();
    if (!start.started) throw new Error(start.reason);
    expect(await acc.cancelLogin(start.loginId)).toBe('canceled');
    await waitFor(() => events.some((e) => e.type === 'loginCompleted'));
    expect(events.find((e) => e.type === 'loginCompleted')).toMatchObject({
      result: { loginId: start.loginId, success: false },
    });
    expect(await acc.cancelLogin(start.loginId)).toBe('not_found');
    expect(await acc.cancelLogin('nope')).toBe('not_found');
    expect(await acc.read()).toEqual({ state: 'needs_login' });
  });

  it('실패 완료 알림은 상태를 바꾸지 않는다', async () => {
    const { acc, events, c } = setup();
    await acc.read();
    const start = await acc.startLogin();
    if (!start.started) throw new Error(start.reason);
    await c.request('test/completeLogin', { loginId: start.loginId, success: false });
    await waitFor(() => events.some((e) => e.type === 'loginCompleted'));
    expect(events.find((e) => e.type === 'loginCompleted')).toMatchObject({
      result: { success: false, error: 'fake: user denied' },
    });
    expect(acc.lastStatus).toEqual({ state: 'needs_login' });
  });
});

const binary: CodexBinary | null = (() => {
  try {
    return resolveCodexBinary();
  } catch {
    return null;
  }
})();

describe.skipIf(!binary)('CodexAccount (실제 app-server, 앱 전용 CODEX_HOME이라 미로그인)', () => {
  it('needs_login·한도 needs_login·로그인 시작 URL·취소', async () => {
    const userData = await fs.mkdtemp(join(tmpdir(), 'paperlens-userdata-'));
    const rt = new CodexRuntime({ userDataPath: userData, appVersion: '0.0.0-test' });
    await rt.start();
    try {
      const acc = new CodexAccount(() => rt.client);
      const events: LlmAccountEvent[] = [];
      acc.onEvent((e) => events.push(e));
      acc.attach();
      expect(await acc.read()).toEqual({ state: 'needs_login' });
      expect(await acc.readRateLimits()).toEqual({
        available: false,
        reason: 'needs_login',
        message:
          'account/rateLimits/read: codex account authentication required to read rate limits',
      });
      // login/start는 localhost:1455 콜백 서버를 연다(브라우저는 열지 않는다). 포트가 사용 중이면 여기서 실패한다.
      const start = await acc.startLogin();
      if (!start.started) throw new Error(start.reason);
      const url = new URL(start.authUrl);
      expect(url.hostname).toBe('auth.openai.com');
      expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
      expect(url.searchParams.get('originator')).toBe('paperlens');
      expect(await acc.cancelLogin(start.loginId)).toBe('canceled');
      const end = Date.now() + 5_000;
      while (!events.some((e) => e.type === 'loginCompleted') && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(events.find((e) => e.type === 'loginCompleted')).toMatchObject({
        result: { loginId: start.loginId, success: false },
      });
      expect(await acc.cancelLogin(start.loginId)).toBe('not_found');
      expect(acc.lastStatus).toEqual({ state: 'needs_login' });
    } finally {
      await rt.stop();
    }
  }, 40_000);
});
