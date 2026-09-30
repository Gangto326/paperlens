import type { LlmAccountEvent, LlmRateLimits } from '@shared/ipc';

/**
 * 한도 초과·인증 만료 뒤의 자동 재개(PLAN 10절, COMMIT_PLAN C3.5).
 * - `waiting_quota`로 멈춘 논문: 한도의 갱신 시각(resetsAt)이 있으면 그 뒤에 한도를 다시 읽고, 풀렸으면 처리를 다시
 *   시작한다. 시각이 없으면 정해진 주기로 확인한다. 앱이 실행 중일 때만 돈다. 앱을 끄면 아무것도 약속하지 않는다.
 * - `needs_login`으로 멈춘 논문: 로그인이 끝나면 처리를 다시 시작한다.
 * - 한 번에 논문 하나만 기다린다. 새로 멈춘 논문이 앞의 것을 대신한다.
 * - 별도 결제, 크레딧 구매, 한도 초기화는 하지 않는다. 한도를 읽고 시작을 부를 뿐이다.
 * 갱신 시각의 뜻: 한도 창(primary·secondary)마다 사용률과 갱신 시각이 온다. 사용률이 다 찬 창의 갱신 시각 가운데
 * 가장 늦은 것을 기다린다. 다 찬 창이 없으면(다른 이유의 한도) 앞으로 올 갱신 시각 가운데 가장 이른 것을 기다린다.
 * 그마저 없으면 주기 확인이다.
 */
export const QUOTA_POLL_MS = 15 * 60_000;
/** 갱신 시각 바로 뒤에는 아직 안 풀렸을 수 있어 조금 늦게 본다. */
export const QUOTA_RESET_MARGIN_MS = 60_000;

export interface AutoResumeDeps {
  readRateLimits: () => Promise<LlmRateLimits>;
  /** 처리를 시작한다. 시작하지 못한 이유를 돌려준다(이미 처리 중 등). */
  start: (pdfSha256: string, trigger: string) => { started: boolean; reason: string | null };
  onAccountEvent: (handler: (event: LlmAccountEvent) => void) => () => void;
  now?: () => Date;
  log?: (line: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export type WaitingStatus =
  | { kind: 'none' }
  | { kind: 'quota'; pdfSha256: string; resumeAt: string | null }
  | { kind: 'login'; pdfSha256: string };

/** 한도 응답에서 다음에 확인할 시각. null이면 시각을 모르는 것이다. */
export function quotaResumeAt(limits: LlmRateLimits, now: Date): Date | null {
  if (!limits.available) return null;
  const windows = [limits.primary, limits.secondary].filter((w) => w !== null);
  const future = (iso: string | null): Date | null => {
    if (iso === null) return null;
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) || at.getTime() <= now.getTime() ? null : at;
  };
  const exhausted = windows
    .filter((w) => w.usedPercent >= 100)
    .map((w) => future(w.resetsAt))
    .filter((d) => d !== null);
  if (exhausted.length > 0) {
    return new Date(Math.max(...exhausted.map((d) => d.getTime())));
  }
  const upcoming = windows.map((w) => future(w.resetsAt)).filter((d) => d !== null);
  if (upcoming.length > 0) return new Date(Math.min(...upcoming.map((d) => d.getTime())));
  return null;
}

/** 한도가 아직 차 있는지. 사용률이 다 찬 창이 하나라도 있으면 차 있는 것이다. 읽지 못했으면 모른다(false). */
export const quotaExhausted = (limits: LlmRateLimits): boolean =>
  limits.available &&
  [limits.primary, limits.secondary].some((w) => w !== null && w.usedPercent >= 100);

export class AutoResume {
  private waiting: WaitingStatus = { kind: 'none' };
  private timer: unknown = null;
  private offAccount: (() => void) | null = null;
  private readonly listeners = new Set<(status: WaitingStatus) => void>();
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: AutoResumeDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => undefined);
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get status(): WaitingStatus {
    return this.waiting;
  }

  onChange(listener: (status: WaitingStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 한도에 걸려 멈춘 논문을 기다린다. 한도를 한 번 읽어 확인 시각을 정한다. */
  async waitForQuota(pdfSha256: string): Promise<void> {
    this.reset();
    this.set({ kind: 'quota', pdfSha256, resumeAt: null });
    await this.checkQuota(pdfSha256, '한도 대기 시작');
  }

  /** 로그인이 필요해 멈춘 논문을 기다린다. 로그인이 끝나면 시작한다. */
  waitForLogin(pdfSha256: string): void {
    this.reset();
    this.set({ kind: 'login', pdfSha256 });
    this.offAccount = this.deps.onAccountEvent((event) => {
      const loggedIn =
        (event.type === 'loginCompleted' && event.result.success) ||
        (event.type === 'account' && event.status.state === 'authenticated');
      if (!loggedIn || this.waiting.kind !== 'login') return;
      this.log(`auto-resume ${pdfSha256.slice(0, 8)} 로그인 확인, 다시 시작`);
      this.resume(pdfSha256, '로그인 완료');
    });
  }

  /** 기다림을 그만둔다. 사용자가 직접 시작했거나 논문을 닫았을 때 부른다. */
  cancel(): void {
    if (this.waiting.kind === 'none') return;
    this.reset();
    this.set({ kind: 'none' });
  }

  private reset(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.offAccount?.();
    this.offAccount = null;
  }

  private set(status: WaitingStatus): void {
    this.waiting = status;
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch (err) {
        this.log(`auto-resume listener 예외: ${String(err)}`);
      }
    }
  }

  private resume(pdfSha256: string, trigger: string): void {
    this.reset();
    this.set({ kind: 'none' });
    const started = this.deps.start(pdfSha256, trigger);
    if (!started.started) {
      this.log(`auto-resume ${pdfSha256.slice(0, 8)} 시작하지 못함: ${String(started.reason)}`);
    }
  }

  private async checkQuota(pdfSha256: string, trigger: string): Promise<void> {
    let limits: LlmRateLimits;
    try {
      limits = await this.deps.readRateLimits();
    } catch (err) {
      limits = { available: false, reason: 'error', message: String(err) };
    }
    if (this.waiting.kind !== 'quota' || this.waiting.pdfSha256 !== pdfSha256) return;
    const now = this.now();
    if (limits.available && !quotaExhausted(limits) && trigger !== '한도 대기 시작') {
      this.log(`auto-resume ${pdfSha256.slice(0, 8)} 한도가 풀림, 다시 시작 (${trigger})`);
      this.resume(pdfSha256, trigger);
      return;
    }
    const at = quotaResumeAt(limits, now);
    const delay =
      at === null
        ? QUOTA_POLL_MS
        : Math.max(0, at.getTime() - now.getTime()) + QUOTA_RESET_MARGIN_MS;
    const resumeAt = new Date(now.getTime() + delay).toISOString();
    this.set({ kind: 'quota', pdfSha256, resumeAt });
    this.log(
      `auto-resume ${pdfSha256.slice(0, 8)} 한도 확인 예정 ${resumeAt}${at === null ? ' (갱신 시각 없음, 주기 확인)' : ''}`,
    );
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.checkQuota(pdfSha256, '한도 확인');
    }, delay);
  }
}
