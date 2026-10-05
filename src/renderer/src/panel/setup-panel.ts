import type { SetupAgentState } from '@shared/setup-diagnosis';
import {
  installationSteps,
  SETUP_STEPS,
  SETUP_TROUBLESHOOTING,
  setupStep,
  type SetupAction,
  type SetupState,
} from '@shared/local-setup';

const ACTION_LABELS: Record<SetupAction, string> = {
  prepare: '자동 준비 시작',
  cancel: '준비 중단',
  open_docker: 'Docker 열기',
  open_installer: '설치 파일 다시 열기',
  install_wsl: 'Windows 실행 환경 설치·업데이트',
};
export class SetupPanel {
  private readonly dialog = document.createElement('dialog');
  private state: SetupState | null = null;
  private actionBusy = false;
  private helpBusy = false;
  private agentState: SetupAgentState | null = null;
  constructor(private readonly onReady: () => void) {
    this.dialog.id = 'local-setup';
    this.dialog.setAttribute('aria-labelledby', 'setup-title');
    this.dialog.innerHTML = `
      <header class="setup-header"><span>처음 한 번, 이 컴퓨터에서</span><button type="button" class="icon-button" id="setup-close" aria-label="준비 안내 닫기">×</button></header>
      <h2 id="setup-title">논문을 읽을 준비</h2>
      <p class="setup-intro">Docker는 논문 분석기를 실행하는 프로그램입니다. PDF 구조 분석은 내 컴퓨터에서 처리하고, 번역·해설은 연결한 ChatGPT 계정을 사용합니다.</p>
      <ol class="setup-steps" aria-label="준비 순서"></ol>
      <section class="setup-current" aria-label="현재 준비 상태"><p id="setup-message" role="status" aria-live="polite">준비 상태를 확인하고 있습니다.</p><progress id="setup-progress" max="100" hidden aria-label="Docker 다운로드 진행률"></progress><p id="setup-machine" class="muted"></p></section>
      <p id="setup-action-error" role="alert"></p>
      <label class="setup-consent"><input type="checkbox" id="setup-consent"> Docker·Windows 실행 환경(WSL)·논문 분석기의 진단·설치·실행·복구 및 다음 앱 실행 시 자동 시작에 동의합니다. Docker 약관은 설치 창에서 직접 확인합니다.</label>
      <p class="muted setup-footnote">처음에는 인터넷과 약 10GB의 여유 공간이 필요합니다. RAM 8GB 이상을 권장합니다. 창을 닫아도 준비는 계속됩니다. “준비 중단”은 설치 창을 닫거나 설치된 프로그램을 삭제하지 않습니다.</p>
      <div class="setup-actions"><button type="button" class="primary" id="setup-agent-start">Codex에게 진단·자동 해결 맡기기</button><button type="button" id="setup-agent-stop" hidden>자동 해결 중단</button><button type="button" data-setup="prepare">기본 자동 준비 시작</button><button type="button" data-setup="cancel" hidden>준비 중단</button><button type="button" data-setup="open_docker">Docker 열기</button><button type="button" data-setup="open_installer" hidden>설치 파일 다시 열기</button></div>
      <p class="muted setup-footnote">Codex는 실제 진단 결과를 읽고 필요한 조치를 실행한 뒤 다시 확인합니다. ChatGPT 로그인이 필요하며 사용 한도를 사용합니다. 설치 승인·약관 동의·재부팅은 직접 진행해주세요.</p>
      <p id="setup-agent-status" role="status" aria-live="polite"></p>
      <p id="setup-auto-note" class="muted"></p>
      <details class="setup-guide" open><summary>내가 해야 할 일</summary><ol id="setup-instructions"></ol><button type="button" data-setup="install_wsl" hidden>Windows 실행 환경 설치·업데이트</button><p id="setup-wsl-note" class="muted" hidden>Windows 승인 창에서 “예”를 누르세요. 열린 창에 완료 안내가 나올 때까지 기다리세요. 작업을 저장한 뒤 필요하면 직접 재부팅하고 PaperLens를 다시 여세요. 앱은 강제로 재부팅하지 않습니다.</p></details>
      <details class="setup-guide"><summary>막혔을 때 따라 하기</summary><div id="setup-troubleshooting"></div></details>
      <details class="setup-guide"><summary>진단 결과와 GPT 도움</summary>
        <p class="muted">ChatGPT 로그인과 사용 한도가 필요합니다. 운영체제·메모리·여유 공간·Docker·WSL·분석기 상태와 오류 흔적, 아래 질문을 전송합니다. PDF·계정 정보·파일 경로·로그 원문은 전송하지 않습니다. 비밀번호를 적지 마세요. “맡기기”는 조치까지 자동으로 진행하고, “진단·설명만 받기”는 상태를 확인하고 설명합니다.</p>
        <ul id="setup-diagnosis"></ul><ol id="setup-agent-history"></ol><label for="setup-question">어디에서 막혔나요?</label><textarea id="setup-question" rows="3" maxlength="2000" placeholder="예: Docker 창에서 WSL 업데이트가 필요하다고 나와요"></textarea>
        <div class="setup-actions"><button type="button" id="setup-ask">진단·설명만 받기</button><button type="button" id="setup-login">ChatGPT 로그인</button></div><p id="setup-answer" aria-live="polite"></p><div id="setup-recommendation"></div>
      </details>
      <p class="muted setup-footnote">개인·교육 용도 등은 Docker Desktop 무료 대상입니다. 회사·기관에서는 조직의 Docker 이용 조건을 확인하세요. 설치 단계와 문제 해결 안내는 이 앱 안에서 계속 볼 수 있습니다.</p>`;
    document.body.append(this.dialog);
    this.el<HTMLButtonElement>('#setup-close').onclick = () => this.dialog.close();
    this.el<HTMLInputElement>('#setup-consent').onchange = () => this.renderButtons();
    this.dialog.querySelectorAll<HTMLButtonElement>('[data-setup]').forEach((button) => {
      button.onclick = () => void this.act(button.dataset['setup'] as SetupAction);
    });
    for (const [title, text] of SETUP_TROUBLESHOOTING) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = title;
      const p = document.createElement('p');
      p.textContent = text;
      details.append(summary, p);
      this.el('#setup-troubleshooting').append(details);
    }
    for (const step of SETUP_STEPS) {
      const li = document.createElement('li');
      li.textContent = step;
      this.el('.setup-steps').append(li);
    }
    this.el<HTMLButtonElement>('#setup-agent-start').onclick = () => void this.startAgent();
    this.el<HTMLButtonElement>('#setup-agent-stop').onclick = () => {
      void window.paperlens
        .cancelSetupAgent()
        .then((state) => this.updateAgent(state))
        .catch((error: unknown) => {
          this.el('#setup-action-error').textContent = String(error);
        });
    };
    window.paperlens.onSetupAgentEvent((state) => this.updateAgent(state));
    void window.paperlens
      .readSetupAgent()
      .then((state) => this.updateAgent(state))
      .catch(() => undefined);
    this.el<HTMLButtonElement>('#setup-ask').onclick = () => void this.ask();
    this.el<HTMLButtonElement>('#setup-login').onclick = () => {
      void window.paperlens
        .startLogin()
        .then((result) => {
          this.el('#setup-answer').textContent = result.started
            ? '브라우저에서 ChatGPT 로그인 후 이 창으로 돌아와 도움받기를 다시 누르세요.'
            : result.reason;
        })
        .catch((error: unknown) => {
          this.el('#setup-answer').textContent = String(error);
        });
    };
    window.paperlens.onSetupEvent((state) => this.update(state));
    void window.paperlens
      .readSetup()
      .then((state) => this.update(state))
      .catch((error: unknown) => {
        this.el('#setup-action-error').textContent = String(error);
      });
    document.getElementById('btn-setup')?.addEventListener('click', () => this.open());
    document.getElementById('btn-welcome-setup')?.addEventListener('click', () => this.open());
  }
  private el<T extends HTMLElement = HTMLElement>(selector: string): T {
    return this.dialog.querySelector<T>(selector)!;
  }
  open(): void {
    if (!this.dialog.open) this.dialog.showModal();
    void window.paperlens
      .readSetup()
      .then((state) => this.update(state))
      .catch((error: unknown) => {
        this.el('#setup-action-error').textContent = String(error);
      });
  }
  private update(state: SetupState): void {
    const prior = this.state;
    this.state = state;
    this.el('#setup-message').textContent = state.message;
    this.el('#setup-machine').textContent =
      `${state.platform === 'darwin' ? 'Mac' : state.platform === 'win32' ? 'Windows' : state.platform} · ${state.arch === 'arm64' ? 'Apple silicon / ARM' : 'Intel / AMD'} · 메모리 ${state.memoryGB}GB${state.memoryGB < 8 ? ' — 다른 프로그램을 닫고 준비해주세요.' : ''}`;
    const progress = this.el<HTMLProgressElement>('#setup-progress');
    progress.hidden = state.phase !== 'downloading_docker';
    if (state.progress === null) progress.removeAttribute('value');
    else progress.value = state.progress;
    this.el('#setup-auto-note').textContent = state.autoStart
      ? '다음 실행에도 자동으로 준비합니다. PaperLens가 관리하는 분석기는 앱을 완전히 종료하면 중지합니다. Docker 자체는 종료하지 않습니다.'
      : '다음 앱 실행 시 자동 준비가 꺼져 있습니다.';
    if (state.autoStart) this.el<HTMLInputElement>('#setup-consent').checked = true;
    const step = setupStep(state.phase);
    this.dialog.querySelectorAll<HTMLElement>('.setup-steps li').forEach((li, i) => {
      li.dataset['state'] =
        i < step || state.phase === 'ready' ? 'done' : i === step ? 'current' : 'later';
      if (i === step) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    });
    if (!prior || prior.platform !== state.platform) {
      this.el('#setup-instructions').replaceChildren(
        ...installationSteps(state.platform).map((text) => {
          const li = document.createElement('li');
          li.textContent = text;
          return li;
        }),
      );
    }
    this.el('#setup-wsl-note').hidden = state.platform !== 'win32';
    this.renderButtons();
    if (state.phase === 'ready' && prior?.phase !== 'ready') this.onReady();
  }
  private renderButtons(): void {
    const state = this.state;
    const agentBusy = this.agentState?.busy === true;
    this.el<HTMLButtonElement>('#setup-agent-start').disabled =
      agentBusy || this.actionBusy || !this.el<HTMLInputElement>('#setup-consent').checked;
    this.el<HTMLButtonElement>('#setup-agent-stop').hidden = !agentBusy;
    this.el<HTMLButtonElement>('#setup-ask').disabled = agentBusy || this.helpBusy;
    const consent = this.el<HTMLInputElement>('#setup-consent').checked;
    this.dialog.querySelectorAll<HTMLButtonElement>('[data-setup]').forEach((button) => {
      const action = button.dataset['setup'];
      button.disabled =
        this.actionBusy ||
        agentBusy ||
        !state ||
        (action === 'prepare' && (state.busy || !consent));
      if (action === 'cancel') {
        button.hidden = !state?.busy && !state?.autoStart;
        button.textContent = state?.busy ? '준비 중단' : '다음 실행 자동 시작 끄기';
      }
      if (action === 'open_installer')
        button.hidden =
          !state || !['install_docker', 'starting_docker', 'error'].includes(state.phase);
      if (action === 'install_wsl') button.hidden = state?.platform !== 'win32';
    });
  }
  private async act(action: SetupAction): Promise<void> {
    if (this.actionBusy || this.agentState?.busy) return;
    if (action === 'prepare' && !this.el<HTMLInputElement>('#setup-consent').checked) {
      this.el('#setup-action-error').textContent =
        '먼저 위의 다운로드·실행 동의 항목을 선택해주세요.';
      return;
    }
    this.actionBusy = true;
    this.renderButtons();
    this.el('#setup-action-error').textContent = '';
    try {
      this.update(await window.paperlens.setupAction(action));
    } catch (error) {
      this.el('#setup-action-error').textContent =
        error instanceof Error ? error.message : String(error);
    } finally {
      this.actionBusy = false;
      this.renderButtons();
    }
  }
  private async startAgent(): Promise<void> {
    if (this.agentState?.busy || this.actionBusy) return;
    this.actionBusy = true;
    this.renderButtons();
    this.el('#setup-action-error').textContent = '';
    try {
      const state = await window.paperlens.startSetupAgent(
        this.el<HTMLTextAreaElement>('#setup-question').value,
        this.el<HTMLInputElement>('#setup-consent').checked,
      );
      this.updateAgent(state);
    } catch (error) {
      this.el('#setup-action-error').textContent =
        error instanceof Error ? error.message : String(error);
    } finally {
      this.actionBusy = false;
      this.renderButtons();
    }
  }
  private updateAgent(state: SetupAgentState): void {
    const prior = this.agentState;
    this.agentState = state;
    this.el('#setup-agent-status').textContent = state.phase === 'idle' ? '' : state.message;
    const d = state.diagnosis;
    const lines = d
      ? [
          `확인 시각: ${new Date(d.checkedAt).toLocaleTimeString()}`,
          `저장 공간: ${d.freeDiskGB === null ? '확인하지 못함' : d.freeDiskGB + 'GB 남음'} · 메모리: ${d.memoryGB}GB`,
          `Docker: ${d.desktopInstalled ? '설치됨' : '찾지 못함'} / ${d.docker.reachable ? '응답함' : '응답 없음'}`,
          `분석기 이미지: ${d.docker.imagePresent === null ? '확인하지 못함' : d.docker.imagePresent ? '있음' : '없음'}`,
          `분석기 실행: ${d.container.running ? '실행 중' : '실행 확인 안 됨'} / 실제 응답: ${d.grobidHealthy ? '정상' : '없음'}`,
          ...(d.platform === 'win32'
            ? [
                `Windows 실행 환경: ${d.wsl === 'ready' ? '응답함' : '확인 필요'} · 가상화: ${d.virtualization === 'enabled' ? '켜짐' : d.virtualization === 'disabled' ? '꺼짐' : '확인하지 못함'}`,
              ]
            : []),
          ...(d.container.oomKilled ? ['분석기가 메모리 부족으로 종료된 기록이 있습니다.'] : []),
        ]
      : [];
    this.el('#setup-diagnosis').replaceChildren(
      ...lines.map((text) => {
        const li = document.createElement('li');
        li.textContent = text;
        return li;
      }),
    );
    this.el('#setup-agent-history').replaceChildren(
      ...state.history.map((entry) => {
        const li = document.createElement('li');
        li.textContent = `${entry.explanation} → ${entry.result}`;
        return li;
      }),
    );
    this.renderButtons();
    if (state.phase === 'ready' && prior?.phase !== 'ready') this.onReady();
  }
  private async ask(): Promise<void> {
    if (this.helpBusy || this.agentState?.busy) return;
    this.helpBusy = true;
    const button = this.el<HTMLButtonElement>('#setup-ask');
    button.disabled = true;
    this.el('#setup-answer').textContent = '현재 준비 상태를 바탕으로 설명을 작성하고 있습니다…';
    this.el('#setup-recommendation').replaceChildren();
    try {
      const advice = await window.paperlens.setupHelp(
        this.el<HTMLTextAreaElement>('#setup-question').value,
      );
      this.el('#setup-answer').textContent = advice.explanation;
      if (advice.action !== 'none') {
        const action = advice.action;
        const next = document.createElement('button');
        next.type = 'button';
        next.textContent = ACTION_LABELS[action];
        next.onclick = () => void this.act(action);
        this.el('#setup-recommendation').append(next);
      }
    } catch (error) {
      this.el('#setup-answer').textContent = error instanceof Error ? error.message : String(error);
    } finally {
      this.helpBusy = false;
      this.renderButtons();
    }
  }
}
