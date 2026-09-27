import type { LlmAccountEvent, LlmAccountStatus, LlmRateLimits } from '@shared/ipc';
import { accountViewModel, type AccountAction } from './account-view';

/**
 * 우측 패널 상단의 계정·한도 표시와 로그인/로그아웃 버튼(C1.19). 상태는 main의 푸시 이벤트로 갱신하고,
 * 버튼은 preload API를 통해 main에 요청만 한다(브라우저 열기·완료 감지는 main 몫).
 */
export class AccountPanel {
  private status: LlmAccountStatus = { state: 'unavailable', reason: '확인 중' };
  private limits: LlmRateLimits = { available: false, reason: 'unavailable', message: '확인 중' };
  private loginId: string | null = null;
  private readonly textEl: HTMLElement;
  private readonly limitsEl: HTMLElement;
  private readonly buttonEl: HTMLButtonElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly onError: (err: unknown) => void,
  ) {
    root.replaceChildren();
    this.textEl = document.createElement('span');
    this.textEl.className = 'account-text';
    this.limitsEl = document.createElement('span');
    this.limitsEl.className = 'account-limits muted';
    this.buttonEl = document.createElement('button');
    this.buttonEl.type = 'button';
    this.buttonEl.addEventListener('click', () => void this.act().catch(this.onError));
    root.append(this.textEl, this.buttonEl, this.limitsEl);
    this.render();
  }

  /** 초기 조회와 푸시 구독. 반환값은 구독 해제 함수. */
  async start(): Promise<() => void> {
    const off = window.paperlens.onAccountEvent((event) => this.apply(event));
    this.status = await window.paperlens.readAccount();
    if (this.status.state === 'authenticated') {
      this.limits = await window.paperlens.readRateLimits();
    }
    this.render();
    return off;
  }

  apply(event: LlmAccountEvent): void {
    switch (event.type) {
      case 'account':
        this.status = event.status;
        if (event.status.state !== 'needs_login') this.loginId = null;
        break;
      case 'rateLimits':
        this.limits = event.rateLimits;
        break;
      case 'loginCompleted':
        if (event.result.loginId === this.loginId || event.result.loginId === null) {
          this.loginId = null;
        }
        if (!event.result.success && event.result.error) {
          console.warn(`[paperlens] 로그인 실패: ${event.result.error}`);
        }
        break;
    }
    this.render();
  }

  private async act(): Promise<void> {
    const action = this.buttonEl.dataset['action'] as AccountAction | undefined;
    if (!action) return;
    this.buttonEl.disabled = true;
    try {
      if (action === 'login') {
        const start = await window.paperlens.startLogin();
        if (start.started) this.loginId = start.loginId;
        else this.onError(new Error(`로그인을 시작하지 못했습니다: ${start.reason}`));
      } else if (action === 'cancel') {
        if (this.loginId) await window.paperlens.cancelLogin(this.loginId);
        this.loginId = null;
      } else {
        this.status = await window.paperlens.logout();
      }
    } finally {
      this.buttonEl.disabled = false;
      this.render();
    }
  }

  private render(): void {
    const vm = accountViewModel({
      status: this.status,
      limits: this.limits,
      loginPending: this.loginId !== null,
      now: new Date(),
    });
    this.root.dataset['tone'] = vm.tone;
    this.textEl.textContent = vm.text;
    this.limitsEl.textContent = vm.limits;
    this.limitsEl.hidden = vm.limits === '';
    if (vm.button) {
      this.buttonEl.hidden = false;
      this.buttonEl.textContent = vm.button.label;
      this.buttonEl.dataset['action'] = vm.button.action;
    } else {
      this.buttonEl.hidden = true;
      delete this.buttonEl.dataset['action'];
    }
    console.info(`[paperlens] account ${vm.text}${vm.limits ? ` | ${vm.limits}` : ''}`);
  }
}
