import type {
  LlmAccountEvent,
  LlmAccountStatus,
  LlmLoginCancel,
  LlmLoginCompleted,
  LlmLoginStart,
  LlmRateLimits,
  LlmRateLimitWindow,
} from '@shared/ipc';
import { AppServerError } from './app-server-client';
import type { AccountLoginCompletedNotification } from './protocol/v2/AccountLoginCompletedNotification';
import type { AccountRateLimitsUpdatedNotification } from './protocol/v2/AccountRateLimitsUpdatedNotification';
import type { AccountUpdatedNotification } from './protocol/v2/AccountUpdatedNotification';
import type { CancelLoginAccountParams } from './protocol/v2/CancelLoginAccountParams';
import type { CancelLoginAccountResponse } from './protocol/v2/CancelLoginAccountResponse';
import type { GetAccountParams } from './protocol/v2/GetAccountParams';
import type { GetAccountRateLimitsParams } from './protocol/v2/GetAccountRateLimitsParams';
import type { GetAccountRateLimitsResponse } from './protocol/v2/GetAccountRateLimitsResponse';
import type { GetAccountResponse } from './protocol/v2/GetAccountResponse';
import type { LoginAccountParams } from './protocol/v2/LoginAccountParams';
import type { LoginAccountResponse } from './protocol/v2/LoginAccountResponse';
import type { LogoutAccountResponse } from './protocol/v2/LogoutAccountResponse';
import type { RateLimitSnapshot } from './protocol/v2/RateLimitSnapshot';
import type { RateLimitWindow } from './protocol/v2/RateLimitWindow';

/**
 * 계정·로그인·한도 어댑터(COMMIT_PLAN C1.19, PLAN 4.2 표의 "인증 상태 확인·로그인"·"사용 한도 조회").
 * App Server 0.157.1 실측:
 * - `account/read {refreshToken:false}` → 미로그인이면 `{account:null, requiresOpenaiAuth:true}`.
 * - `account/rateLimits/read` → 미로그인이면 error -32600 "codex account authentication required to read rate limits".
 * - `account/login/start {type:'chatgpt'}` → `{loginId, authUrl}`; 서버가 localhost:1455 콜백을 연다. 두 번째 start는 첫 로그인을
 *   취소하며(`account/login/completed success:false "Login cancelled"`), `account/login/cancel`도 completed 알림을 낸다.
 * - 알림에는 프로토콜 타입에 없는 `emittedAtMs`가 함께 온다(무시).
 * Codex 고유 타입은 이 파일 안에서만 쓰고 밖으로는 `@shared/ipc`의 Llm* 형태만 내보낸다.
 */
export interface AccountTransport {
  readonly state: 'running' | 'closing' | 'exited';
  request<T>(method: string, params?: unknown): Promise<T>;
  onNotification(method: string, handler: (params: unknown) => void): () => void;
}

export type AccountEventHandler = (event: LlmAccountEvent) => void;

const UNAVAILABLE = (reason: string): LlmAccountStatus => ({ state: 'unavailable', reason });

/** 프로토콜 계정 응답 → 앱 상태. */
export function toAccountStatus(res: GetAccountResponse): LlmAccountStatus {
  const account = res.account;
  if (!account) return { state: 'needs_login' };
  switch (account.type) {
    case 'chatgpt':
      return {
        state: 'authenticated',
        method: 'chatgpt',
        email: account.email,
        plan: account.planType,
      };
    case 'apiKey':
      return { state: 'authenticated', method: 'api_key', email: null, plan: null };
    default:
      return { state: 'authenticated', method: 'other', email: null, plan: null };
  }
}

/**
 * `resetsAt`은 프로토콜 타입이 number|null이고 단위 설명이 없다. Codex CLI가 Unix 초를 쓰므로 초로 보되,
 * 1e12 이상이면 밀리초로 본다(초 단위로는 서기 33658년이라 혼동 여지가 없다). 로그인 후 실값으로 확인할 것.
 */
export function resetsAtToIso(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const ms = value >= 1e12 ? value : value * 1000;
  return new Date(ms).toISOString();
}

function toWindow(w: RateLimitWindow | null): LlmRateLimitWindow | null {
  if (!w) return null;
  return {
    usedPercent: w.usedPercent,
    windowMinutes: w.windowDurationMins,
    resetsAt: resetsAtToIso(w.resetsAt),
  };
}

/** 프로토콜 한도 스냅샷 → 앱 한도. 창이 둘 다 없으면 available이되 값이 null이라 UI는 "확인 불가"로 표시한다. */
export function toRateLimits(snapshot: RateLimitSnapshot, readAt: Date): LlmRateLimits {
  return {
    available: true,
    primary: toWindow(snapshot.primary),
    secondary: toWindow(snapshot.secondary),
    plan: snapshot.planType,
    readAt: readAt.toISOString(),
  };
}

/** 한도 조회 실패 → 앱 한도. 미로그인 오류는 needs_login으로 구분한다. */
export function rateLimitsFromError(err: unknown): LlmRateLimits {
  if (err instanceof AppServerError && err.kind === 'rpc') {
    const needsLogin = /authentication required/i.test(err.message);
    return {
      available: false,
      reason: needsLogin ? 'needs_login' : 'error',
      message: err.message,
    };
  }
  return {
    available: false,
    reason: 'error',
    message: err instanceof Error ? err.message : String(err),
  };
}

export class CodexAccount {
  private readonly handlers = new Set<AccountEventHandler>();
  private readonly unsubscribe: Array<() => void> = [];
  private readonly log: (line: string) => void;
  /** 마지막으로 확인한 상태(앱 로그·재조회 없이 renderer 초기 표시에 쓴다) */
  lastStatus: LlmAccountStatus = UNAVAILABLE('아직 확인하지 않음');
  lastRateLimits: LlmRateLimits = {
    available: false,
    reason: 'unavailable',
    message: '아직 확인하지 않음',
  };

  private readonly now: () => Date;

  constructor(
    private readonly transport: () => AccountTransport | null,
    options: { log?: (line: string) => void; now?: () => Date } = {},
  ) {
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
  }

  /** 현재 transport의 계정 알림을 구독한다. transport가 바뀌면(재시작) 다시 부른다. */
  attach(): void {
    const t = this.transport();
    if (!t) return;
    this.detach();
    this.unsubscribe.push(
      t.onNotification('account/login/completed', (params) => {
        const p = params as AccountLoginCompletedNotification;
        const result: LlmLoginCompleted = {
          loginId: p.loginId,
          success: p.success,
          error: p.error,
        };
        this.log(
          `login completed success=${String(p.success)}${p.error ? ` error=${p.error}` : ''}`,
        );
        this.emit({ type: 'loginCompleted', result });
        if (p.success) {
          // 로그인 직후 계정·한도를 다시 읽어 상태를 확정한다.
          void this.read()
            .then(() => this.readRateLimits())
            .catch((err: unknown) => this.log(`로그인 후 재조회 실패: ${String(err)}`));
        }
      }),
      t.onNotification('account/updated', (params) => {
        const p = params as AccountUpdatedNotification;
        this.log(`account updated authMode=${String(p.authMode)} plan=${String(p.planType)}`);
        void this.read().catch((err: unknown) => this.log(`계정 재조회 실패: ${String(err)}`));
      }),
      t.onNotification('account/rateLimits/updated', (params) => {
        const p = params as AccountRateLimitsUpdatedNotification;
        this.setRateLimits(toRateLimits(p.rateLimits, this.now()));
      }),
    );
  }

  detach(): void {
    for (const off of this.unsubscribe.splice(0)) off();
  }

  onEvent(handler: AccountEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** account/read. 런타임이 없으면 unavailable. */
  async read(): Promise<LlmAccountStatus> {
    const t = this.running();
    if (!t) return this.setStatus(UNAVAILABLE('LLM 런타임이 실행 중이 아닙니다'));
    try {
      const res = await t.request<GetAccountResponse>('account/read', {
        refreshToken: false,
      } satisfies GetAccountParams);
      return this.setStatus(toAccountStatus(res));
    } catch (err) {
      return this.setStatus(UNAVAILABLE(`계정 조회 실패: ${messageOf(err)}`));
    }
  }

  /** ChatGPT 로그인 시작. 브라우저를 여는 것은 호출자(main) 몫이다. 완료는 loginCompleted 이벤트로 온다. */
  async startLogin(): Promise<LlmLoginStart> {
    const t = this.running();
    if (!t) return { started: false, reason: 'LLM 런타임이 실행 중이 아닙니다' };
    try {
      const res = await t.request<LoginAccountResponse>('account/login/start', {
        type: 'chatgpt',
      } satisfies LoginAccountParams);
      if (res.type !== 'chatgpt') {
        return { started: false, reason: `예상하지 않은 로그인 응답 type=${res.type}` };
      }
      this.log(`login started id=${res.loginId}`);
      return { started: true, loginId: res.loginId, authUrl: res.authUrl };
    } catch (err) {
      return { started: false, reason: messageOf(err) };
    }
  }

  async cancelLogin(loginId: string): Promise<LlmLoginCancel> {
    const t = this.running();
    if (!t) return 'unavailable';
    try {
      const res = await t.request<CancelLoginAccountResponse>('account/login/cancel', {
        loginId,
      } satisfies CancelLoginAccountParams);
      return res.status === 'canceled' ? 'canceled' : 'not_found';
    } catch (err) {
      // 알 수 없는 loginId는 -32600 "invalid login id"로 온다(실측).
      if (err instanceof AppServerError && err.kind === 'rpc') return 'not_found';
      throw err;
    }
  }

  /** account/logout 후 상태를 다시 읽는다. */
  async logout(): Promise<LlmAccountStatus> {
    const t = this.running();
    if (!t) return this.setStatus(UNAVAILABLE('LLM 런타임이 실행 중이 아닙니다'));
    await t.request<LogoutAccountResponse>('account/logout', {});
    this.setRateLimits({
      available: false,
      reason: 'needs_login',
      message: '로그아웃했습니다',
    });
    return this.read();
  }

  /** account/rateLimits/read. 실패는 던지지 않고 available:false로 돌려준다. */
  async readRateLimits(): Promise<LlmRateLimits> {
    const t = this.running();
    if (!t) {
      return this.setRateLimits({
        available: false,
        reason: 'unavailable',
        message: 'LLM 런타임이 실행 중이 아닙니다',
      });
    }
    try {
      const res = await t.request<GetAccountRateLimitsResponse>('account/rateLimits/read', {
        excludeResetCreditDetails: true,
      } satisfies GetAccountRateLimitsParams);
      return this.setRateLimits(toRateLimits(res.rateLimits, this.now()));
    } catch (err) {
      return this.setRateLimits(rateLimitsFromError(err));
    }
  }

  private running(): AccountTransport | null {
    const t = this.transport();
    return t && t.state === 'running' ? t : null;
  }

  private setStatus(status: LlmAccountStatus): LlmAccountStatus {
    this.lastStatus = status;
    this.emit({ type: 'account', status });
    return status;
  }

  private setRateLimits(rateLimits: LlmRateLimits): LlmRateLimits {
    this.lastRateLimits = rateLimits;
    this.emit({ type: 'rateLimits', rateLimits });
    return rateLimits;
  }

  private emit(event: LlmAccountEvent): void {
    for (const h of this.handlers) h(event);
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 로그용 한 줄 요약. */
export function formatAccountStatus(status: LlmAccountStatus): string {
  switch (status.state) {
    case 'unavailable':
      return `account unavailable (${status.reason})`;
    case 'needs_login':
      return 'account needs_login';
    case 'authenticated':
      return `account authenticated method=${status.method} email=${status.email ?? '-'} plan=${status.plan ?? '-'}`;
  }
}

export function formatRateLimits(limits: LlmRateLimits): string {
  if (!limits.available) return `rateLimits unavailable (${limits.reason}: ${limits.message})`;
  const w = (name: string, win: LlmRateLimitWindow | null): string =>
    win
      ? `${name}=${win.usedPercent}%${win.windowMinutes !== null ? `/${win.windowMinutes}min` : ''}${win.resetsAt ? ` resets=${win.resetsAt}` : ''}`
      : `${name}=?`;
  return `rateLimits ${w('primary', limits.primary)} ${w('secondary', limits.secondary)} plan=${limits.plan ?? '-'}`;
}
