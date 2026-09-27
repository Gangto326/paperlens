import { describe, expect, it } from 'vitest';
import type { LlmRateLimits } from '@shared/ipc';
import { accountViewModel, formatLimits, formatResetsAt, formatWindow } from './account-view';

const NOW = new Date(2026, 8, 27, 10, 0, 0); // 지역 시간 2026-09-27 10:00
const sameDay = new Date(2026, 8, 27, 15, 6, 0).toISOString();
const nextDay = new Date(2026, 8, 28, 9, 30, 0).toISOString();

const available: LlmRateLimits = {
  available: true,
  primary: { usedPercent: 12.4, windowMinutes: 300, resetsAt: sameDay },
  secondary: { usedPercent: 3, windowMinutes: 10_080, resetsAt: nextDay },
  plan: 'plus',
  readAt: NOW.toISOString(),
};

describe('account-view', () => {
  it('formatResetsAt: 당일은 시각만, 다른 날은 월-일 포함, 잘못된 값은 빈 문자열', () => {
    expect(formatResetsAt(sameDay, NOW)).toBe('15:06');
    expect(formatResetsAt(nextDay, NOW)).toBe('09-28 09:30');
    expect(formatResetsAt('garbage', NOW)).toBe('');
  });

  it('formatWindow: 사용률·창 길이·재설정 시각, 없는 값은 생략, 창 자체가 없으면 확인 불가', () => {
    expect(formatWindow(available.available ? available.primary : null, NOW)).toBe(
      '12% 사용 · 5시간 창 · 재설정 15:06',
    );
    expect(formatWindow({ usedPercent: 50, windowMinutes: 10_080, resetsAt: null }, NOW)).toBe(
      '50% 사용 · 7일 창',
    );
    expect(formatWindow({ usedPercent: 50, windowMinutes: 90, resetsAt: null }, NOW)).toBe(
      '50% 사용 · 90분 창',
    );
    expect(formatWindow({ usedPercent: 7, windowMinutes: null, resetsAt: null }, NOW)).toBe(
      '7% 사용',
    );
    expect(formatWindow(null, NOW)).toBe('확인 불가');
  });

  it('formatLimits: 두 창을 /로 잇고, 값이 없거나 조회 불가면 확인 불가, 미로그인이면 빈 문자열', () => {
    expect(formatLimits(available, NOW)).toBe(
      '한도: 12% 사용 · 5시간 창 · 재설정 15:06 / 3% 사용 · 7일 창 · 재설정 09-28 09:30',
    );
    expect(
      formatLimits(
        { available: true, primary: null, secondary: null, plan: null, readAt: '' },
        NOW,
      ),
    ).toBe('한도: 확인 불가');
    expect(formatLimits({ available: false, reason: 'error', message: 'x' }, NOW)).toBe(
      '한도: 확인 불가',
    );
    expect(formatLimits({ available: false, reason: 'needs_login', message: 'x' }, NOW)).toBe('');
  });

  it('accountViewModel: unavailable/needs_login(대기 여부)/authenticated에 따른 문구·버튼', () => {
    const needsLogin: LlmRateLimits = { available: false, reason: 'needs_login', message: '' };
    expect(
      accountViewModel({
        status: { state: 'unavailable', reason: 'PAPERLENS_NO_CODEX' },
        limits: needsLogin,
        loginPending: false,
        now: NOW,
      }),
    ).toEqual({
      text: 'LLM 사용 불가: PAPERLENS_NO_CODEX',
      tone: 'muted',
      button: null,
      limits: '',
    });
    expect(
      accountViewModel({
        status: { state: 'needs_login' },
        limits: needsLogin,
        loginPending: false,
        now: NOW,
      }),
    ).toEqual({
      text: 'ChatGPT 로그인 필요',
      tone: 'warn',
      button: { label: 'ChatGPT 로그인', action: 'login' },
      limits: '',
    });
    expect(
      accountViewModel({
        status: { state: 'needs_login' },
        limits: needsLogin,
        loginPending: true,
        now: NOW,
      }),
    ).toMatchObject({ button: { action: 'cancel' } });
    expect(
      accountViewModel({
        status: { state: 'authenticated', method: 'chatgpt', email: 'a@b.c', plan: 'plus' },
        limits: available,
        loginPending: false,
        now: NOW,
      }),
    ).toEqual({
      text: 'ChatGPT 로그인됨 · a@b.c · plus',
      tone: 'ok',
      button: { label: '로그아웃', action: 'logout' },
      limits: '한도: 12% 사용 · 5시간 창 · 재설정 15:06 / 3% 사용 · 7일 창 · 재설정 09-28 09:30',
    });
    expect(
      accountViewModel({
        status: { state: 'authenticated', method: 'api_key', email: null, plan: null },
        limits: { available: false, reason: 'error', message: 'x' },
        loginPending: false,
        now: NOW,
      }),
    ).toMatchObject({ text: 'API 키 로그인됨', limits: '한도: 확인 불가' });
  });
});
