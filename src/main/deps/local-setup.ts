import type { SetupState } from '@shared/local-setup';
import type { DockerStatus } from './docker';

export interface SetupHost {
  platform: string;
  arch: string;
  memoryGB: number;
  installed(this: void): boolean;
  check(this: void): Promise<DockerStatus>;
  download(
    this: void,
    signal: AbortSignal,
    progress: (percent: number | null) => void,
  ): Promise<void>;
  openInstaller(this: void): Promise<void>;
  openDocker(this: void): Promise<void>;
  pull(this: void, signal: AbortSignal, progress: (message: string) => void): Promise<void>;
  start(this: void, signal: AbortSignal): Promise<void>;
  healthy(this: void): Promise<boolean>;
  remember(this: void, enabled: boolean): Promise<void>;
  delay(this: void, signal: AbortSignal): Promise<void>;
  publish(this: void, state: SetupState): void;
}
export function setupFailure(error: unknown): { errorCode: string; message: string } {
  const raw = String(error);
  if (/checksum|untrusted_download/i.test(raw))
    return {
      errorCode: 'integrity',
      message:
        '공식 설치 파일의 무결성을 확인하지 못했습니다. 설치 파일을 열지 않았습니다. 잠시 후 다시 준비를 시작하세요.',
    };
  if (/ENOSPC|no space/i.test(raw))
    return {
      errorCode: 'disk',
      message: '저장 공간이 부족합니다. 최소 10GB의 여유 공간을 확보한 뒤 다시 시작하세요.',
    };
  if (/port[^\n]*(?:allocated|in use)|address already in use|conflict|container_name/i.test(raw))
    return {
      errorCode: 'conflict',
      message:
        '다른 분석기가 같은 이름 또는 연결 위치를 사용 중입니다. 아래 문제 해결 안내를 확인하세요. 기존 컨테이너는 삭제하지 않았습니다.',
    };
  if (/unsupported_platform/i.test(raw))
    return {
      errorCode: 'unsupported',
      message:
        '자동 준비는 Mac(Intel·Apple silicon)과 Windows x64에서 지원합니다. 이 컴퓨터용 자동 설치는 아직 지원하지 않습니다.',
    };
  if (/timeout|timed out/i.test(raw))
    return {
      errorCode: 'timeout',
      message:
        '준비 시간이 초과됐습니다. Docker 창의 승인·약관·재부팅 안내를 마친 뒤 “자동 준비 시작”을 다시 누르세요.',
    };
  return {
    errorCode: 'setup_failed',
    message:
      '준비를 완료하지 못했습니다. 인터넷 연결과 Docker 창의 안내를 확인한 뒤 다시 시작하세요. 아래 문제 해결 안내 또는 GPT 도움을 이용할 수 있습니다.',
  };
}

/** One setup operation per app. Polls are bounded and sequential, independent of renderer refreshes. */
export class LocalSetup {
  private controller: AbortController | null = null;
  private task: Promise<void> | null = null;
  private value: SetupState;
  constructor(private readonly host: SetupHost) {
    this.value = {
      platform: host.platform,
      arch: host.arch,
      memoryGB: host.memoryGB,
      phase: 'idle',
      busy: false,
      message: '처음 한 번 준비하면 이 컴퓨터에서 논문을 분석할 수 있습니다.',
      progress: null,
      errorCode: null,
      autoStart: false,
    };
  }
  read(): SetupState {
    return { ...this.value };
  }
  /** Called only after the diagnostic adapter has verified a live GROBID response. */
  confirmReady(): void {
    if (!this.value.busy)
      this.update({
        phase: 'ready',
        errorCode: null,
        progress: null,
        message: '분석기의 실제 응답을 확인했습니다. 논문을 열어도 됩니다.',
      });
  }
  private update(patch: Partial<SetupState>): void {
    this.value = { ...this.value, ...patch };
    this.host.publish(this.read());
  }
  prepare(rememberChoice = true): Promise<SetupState> {
    if (this.task) return Promise.resolve(this.read());
    const controller = new AbortController();
    this.controller = controller;
    this.update({
      phase: 'checking',
      busy: true,
      progress: null,
      errorCode: null,
      message: '이 컴퓨터의 준비 상태를 확인하고 있습니다.',
    });
    this.task = this.run(controller.signal, rememberChoice)
      .catch((error: unknown) => {
        if (controller.signal.aborted)
          this.update({
            phase: 'cancelled',
            message: '준비를 중단했습니다. 설치된 Docker와 이미 받은 분석기는 유지됩니다.',
            errorCode: null,
          });
        else this.update({ phase: 'error', ...setupFailure(error) });
      })
      .finally(() => {
        this.task = null;
        this.controller = null;
        this.update({ busy: false, progress: null });
      });
    return Promise.resolve(this.read());
  }
  async cancel(): Promise<SetupState> {
    this.controller?.abort();
    await this.task;
    await this.host.remember(false);
    this.update({ autoStart: false });
    return this.read();
  }
  async settled(): Promise<void> {
    await this.task;
  }
  abort(): void {
    this.controller?.abort();
  }
  async resume(): Promise<void> {
    // Consent is persisted by the adapter. Missing installations require an explicit user action.
    this.update({ autoStart: true });
    if (this.host.installed()) await this.prepare();
  }
  private async waitFor(
    signal: AbortSignal,
    check: () => Promise<boolean>,
    attempts: number,
  ): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      signal.throwIfAborted();
      if (await check()) {
        signal.throwIfAborted();
        return;
      }
      await this.host.delay(signal);
    }
    throw new Error('setup_timeout');
  }
  private async run(signal: AbortSignal, rememberChoice: boolean): Promise<void> {
    if (!(
      (this.host.platform === 'darwin' && ['x64', 'arm64'].includes(this.host.arch)) ||
      (this.host.platform === 'win32' && this.host.arch === 'x64')
    ))
      throw new Error('unsupported_platform');
    if (rememberChoice) {
      await this.host.remember(true);
      signal.throwIfAborted();
      this.update({ autoStart: true });
    }
    signal.throwIfAborted();
    if (!this.host.installed()) {
      this.update({
        phase: 'downloading_docker',
        message: 'Docker 설치 파일을 공식 배포처에서 받고 있습니다. 완료 후 설치 창이 열립니다.',
      });
      await this.host.download(signal, (progress) => {
        if (progress !== this.value.progress) this.update({ progress });
      });
      signal.throwIfAborted();
      this.update({
        phase: 'install_docker',
        progress: null,
        message:
          '설치 창을 열었습니다. 아래 “내가 해야 할 일”을 따라 설치를 마치세요. 설치가 확인되면 자동으로 이어집니다.',
      });
      await this.host.openInstaller();
      await this.waitFor(signal, () => Promise.resolve(this.host.installed()), 180);
    }
    const docker = await this.host.check();
    signal.throwIfAborted();
    if (!docker.ok) {
      this.update({
        phase: 'starting_docker',
        message: 'Docker 창에서 약관 동의와 필요한 승인을 마치세요. 준비되면 자동으로 이어집니다.',
      });
      await this.host.openDocker();
      await this.waitFor(signal, async () => (await this.host.check()).ok, 180);
    }
    const current = await this.host.check();
    signal.throwIfAborted();
    if (current.imagePresent !== true) {
      this.update({
        phase: 'downloading_grobid',
        message: '논문 분석기를 받고 있습니다. 첫 준비는 수 분 이상 걸릴 수 있습니다.',
      });
      await this.host.pull(signal, (message) => this.update({ message }));
    }
    signal.throwIfAborted();
    this.update({
      phase: 'starting_grobid',
      message: '분석기를 시작하고 응답을 확인하고 있습니다. 최대 몇 분 걸릴 수 있습니다.',
    });
    await this.host.start(signal);
    await this.waitFor(signal, () => this.host.healthy(), 60);
    this.update({
      phase: 'ready',
      message: '논문 분석 준비가 끝났습니다. ChatGPT 계정에 로그인하고 PDF를 열어보세요.',
      errorCode: null,
    });
  }
}
