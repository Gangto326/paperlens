import { describe, expect, it } from 'vitest';
import type { LlmAccountEvent, LlmRateLimits } from '@shared/ipc';
import {
  AutoResume,
  QUOTA_POLL_MS,
  QUOTA_RESET_MARGIN_MS,
  quotaResumeAt,
  type WaitingStatus,
} from './auto-resume';

const SHA = 'a'.repeat(64);
const T0 = new Date('2026-09-30T04:00:00.000Z');
const limits = (
  primary: { usedPercent: number; resetsAt: string | null } | null,
  secondary: { usedPercent: number; resetsAt: string | null } | null = null,
): LlmRateLimits => ({
  available: true,
  primary: primary ? { ...primary, windowMinutes: null } : null,
  secondary: secondary ? { ...secondary, windowMinutes: null } : null,
  plan: 'plus',
  readAt: T0.toISOString(),
});
const later = (minutes: number): string => new Date(T0.getTime() + minutes * 60_000).toISOString();

describe('quotaResumeAt', () => {
  it('다 찬 창의 갱신 시각 가운데 가장 늦은 것을 고른다', () => {
    expect(
      quotaResumeAt(
        limits(
          { usedPercent: 100, resetsAt: later(30) },
          { usedPercent: 100, resetsAt: later(90) },
        ),
        T0,
      )?.toISOString(),
    ).toBe(later(90));
    expect(
      quotaResumeAt(
        limits({ usedPercent: 100, resetsAt: later(30) }, { usedPercent: 40, resetsAt: later(90) }),
        T0,
      )?.toISOString(),
    ).toBe(later(30));
  });

  it('다 찬 창이 없으면 앞으로 올 갱신 시각 가운데 가장 이른 것, 그것도 없으면 null', () => {
    expect(
      quotaResumeAt(
        limits({ usedPercent: 80, resetsAt: later(30) }, { usedPercent: 40, resetsAt: later(90) }),
        T0,
      )?.toISOString(),
    ).toBe(later(30));
    expect(quotaResumeAt(limits({ usedPercent: 100, resetsAt: later(-5) }), T0)).toBeNull();
    expect(quotaResumeAt(limits({ usedPercent: 100, resetsAt: null }), T0)).toBeNull();
    expect(quotaResumeAt({ available: false, reason: 'error', message: 'x' }, T0)).toBeNull();
  });
});

/** 가짜 시계와 타이머. 시간을 앞으로 돌리면 예정된 타이머가 순서대로 돈다. */
const harness = (replies: LlmRateLimits[]) => {
  let now = T0.getTime();
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let seq = 0;
  const starts: string[] = [];
  const reads: number[] = [];
  const statuses: WaitingStatus[] = [];
  const handlers = new Set<(event: LlmAccountEvent) => void>();
  let startResult = { started: true, reason: null as string | null };
  const auto = new AutoResume({
    readRateLimits: () => {
      reads.push(now);
      return Promise.resolve(
        replies[Math.min(reads.length - 1, replies.length - 1)] as LlmRateLimits,
      );
    },
    start: (sha, trigger) => {
      starts.push(`${sha.slice(0, 2)}:${trigger}`);
      return startResult;
    },
    onAccountEvent: (h) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    now: () => new Date(now),
    setTimer: (fn, ms) => {
      seq += 1;
      timers.push({ at: now + ms, fn, id: seq });
      return seq;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  auto.onChange((s) => statuses.push(s));
  const advance = async (ms: number): Promise<void> => {
    const until = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers.splice(timers.indexOf(next), 1);
      now = next.at;
      next.fn();
      await new Promise((r) => setTimeout(r, 0));
    }
    now = until;
  };
  return {
    auto,
    starts,
    reads,
    statuses,
    timers,
    handlers,
    advance,
    setStartResult: (r: { started: boolean; reason: string | null }) => (startResult = r),
  };
};

describe('AutoResume', () => {
  it('한도 대기: 갱신 시각 뒤에 한도를 다시 읽고, 풀렸으면 시작한다', async () => {
    const h = harness([
      limits({ usedPercent: 100, resetsAt: later(30) }),
      limits({ usedPercent: 3, resetsAt: later(300) }),
    ]);
    await h.auto.waitForQuota(SHA);
    expect(h.auto.status).toEqual({
      kind: 'quota',
      pdfSha256: SHA,
      resumeAt: new Date(T0.getTime() + 30 * 60_000 + QUOTA_RESET_MARGIN_MS).toISOString(),
    });
    expect(h.starts).toEqual([]);
    await h.advance(30 * 60_000);
    expect(h.starts).toEqual([]);
    await h.advance(QUOTA_RESET_MARGIN_MS);
    expect(h.reads).toHaveLength(2);
    expect(h.starts).toEqual(['aa:한도 확인']);
    expect(h.auto.status).toEqual({ kind: 'none' });
    expect(h.timers).toEqual([]);
  });

  it('갱신 시각 뒤에도 차 있으면 다음 갱신 시각까지 다시 기다린다. 시각이 없으면 주기 확인이다', async () => {
    const h = harness([
      limits({ usedPercent: 100, resetsAt: later(10) }),
      limits({ usedPercent: 100, resetsAt: later(50) }),
      { available: false, reason: 'error', message: '읽기 실패' },
      limits({ usedPercent: 10, resetsAt: null }),
    ]);
    await h.auto.waitForQuota(SHA);
    await h.advance(10 * 60_000 + QUOTA_RESET_MARGIN_MS);
    expect(h.starts).toEqual([]);
    expect(h.auto.status).toMatchObject({
      kind: 'quota',
      resumeAt: new Date(T0.getTime() + 50 * 60_000 + QUOTA_RESET_MARGIN_MS).toISOString(),
    });
    await h.advance(40 * 60_000);
    // 읽기에 실패했으면 주기 확인으로 넘어간다.
    expect(h.reads).toHaveLength(3);
    expect(h.starts).toEqual([]);
    await h.advance(QUOTA_POLL_MS);
    expect(h.reads).toHaveLength(4);
    expect(h.starts).toEqual(['aa:한도 확인']);
  });

  it('로그인 대기: 로그인이 끝나면 시작하고, 취소하면 아무것도 하지 않는다', () => {
    const h = harness([]);
    h.auto.waitForLogin(SHA);
    expect(h.auto.status).toEqual({ kind: 'login', pdfSha256: SHA });
    for (const handler of h.handlers) {
      handler({ type: 'loginCompleted', result: { loginId: 'l', success: false, error: 'x' } });
    }
    expect(h.starts).toEqual([]);
    for (const handler of h.handlers) {
      handler({ type: 'loginCompleted', result: { loginId: 'l', success: true, error: null } });
    }
    expect(h.starts).toEqual(['aa:로그인 완료']);
    expect(h.handlers.size).toBe(0);

    h.auto.waitForLogin(SHA);
    h.auto.cancel();
    expect(h.handlers.size).toBe(0);
    expect(h.auto.status).toEqual({ kind: 'none' });
    expect(h.statuses.at(-1)).toEqual({ kind: 'none' });
  });

  it('새로 기다리는 논문이 앞의 것을 대신하고, 시작하지 못하면 기록만 남긴다', async () => {
    const h = harness([
      limits({ usedPercent: 100, resetsAt: later(5) }),
      limits({ usedPercent: 0, resetsAt: null }),
    ]);
    await h.auto.waitForQuota(SHA);
    h.auto.waitForLogin('b'.repeat(64));
    expect(h.timers).toEqual([]);
    expect(h.auto.status).toMatchObject({ kind: 'login' });
    h.setStartResult({ started: false, reason: '이미 처리 중' });
    for (const handler of h.handlers) {
      handler({
        type: 'account',
        status: { state: 'authenticated', method: 'chatgpt', email: null, plan: null },
      });
    }
    expect(h.starts).toEqual(['bb:로그인 완료']);
    expect(h.auto.status).toEqual({ kind: 'none' });
  });
});
