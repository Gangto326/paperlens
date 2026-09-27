import type { LlmAccountStatus, LlmRateLimits, LlmRateLimitWindow } from '@shared/ipc';

/**
 * 계정·한도 표시 뷰 모델(C1.19). DOM 없이 순수하게 문자열과 버튼 동작만 만든다.
 * PLAN 10: 한도 값이 없으면 "확인 불가". 특정 요금제·한도 의미를 가정하지 않고 계정이 준 값만 보여준다.
 */
export type AccountAction = 'login' | 'cancel' | 'logout';

export interface AccountViewModel {
  /** 계정 줄(예: "ChatGPT 로그인 필요") */
  text: string;
  tone: 'muted' | 'ok' | 'warn';
  button: { label: string; action: AccountAction } | null;
  /** 한도 줄. 비어 있으면 표시하지 않는다. */
  limits: string;
}

export interface AccountViewInput {
  status: LlmAccountStatus;
  limits: LlmRateLimits;
  /** 로그인 흐름이 시작돼 브라우저 인증을 기다리는 중 */
  loginPending: boolean;
  now: Date;
}

const durationLabel = (minutes: number | null): string => {
  if (minutes === null) return '';
  if (minutes % 1440 === 0) return `${minutes / 1440}일 창`;
  if (minutes % 60 === 0) return `${minutes / 60}시간 창`;
  return `${minutes}분 창`;
};

const pad = (n: number): string => String(n).padStart(2, '0');

/** 재설정 시각을 지역 시간 "MM-DD HH:mm"으로. 당일이면 "HH:mm". */
export function formatResetsAt(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? time : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

export function formatWindow(w: LlmRateLimitWindow | null, now: Date): string {
  if (!w) return '확인 불가';
  const parts = [`${Math.round(w.usedPercent)}% 사용`];
  const dur = durationLabel(w.windowMinutes);
  if (dur) parts.push(dur);
  if (w.resetsAt) {
    const at = formatResetsAt(w.resetsAt, now);
    if (at) parts.push(`재설정 ${at}`);
  }
  return parts.join(' · ');
}

export function formatLimits(limits: LlmRateLimits, now: Date): string {
  if (!limits.available) {
    if (limits.reason === 'needs_login') return '';
    return '한도: 확인 불가';
  }
  if (!limits.primary && !limits.secondary) return '한도: 확인 불가';
  const items: string[] = [];
  if (limits.primary) items.push(formatWindow(limits.primary, now));
  if (limits.secondary) items.push(formatWindow(limits.secondary, now));
  return `한도: ${items.join(' / ')}`;
}

export function accountViewModel(input: AccountViewInput): AccountViewModel {
  const { status, limits, loginPending, now } = input;
  switch (status.state) {
    case 'unavailable':
      return {
        text: `LLM 사용 불가: ${status.reason}`,
        tone: 'muted',
        button: null,
        limits: '',
      };
    case 'needs_login':
      return loginPending
        ? {
            text: '브라우저에서 ChatGPT 로그인을 마쳐 주세요',
            tone: 'warn',
            button: { label: '로그인 취소', action: 'cancel' },
            limits: '',
          }
        : {
            text: 'ChatGPT 로그인 필요',
            tone: 'warn',
            button: { label: 'ChatGPT 로그인', action: 'login' },
            limits: '',
          };
    case 'authenticated': {
      const who = [status.email, status.plan].filter((v): v is string => Boolean(v)).join(' · ');
      const method =
        status.method === 'chatgpt' ? 'ChatGPT' : status.method === 'api_key' ? 'API 키' : 'LLM';
      return {
        text: `${method} 로그인됨${who ? ` · ${who}` : ''}`,
        tone: 'ok',
        button: { label: '로그아웃', action: 'logout' },
        limits: formatLimits(limits, now),
      };
    }
  }
}
