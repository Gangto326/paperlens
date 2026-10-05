import { app, net, shell } from 'electron';
import { mkdir, readFile, writeFile, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { totalmem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { SetupAction, SetupState } from '@shared/local-setup';
import { diagnoseSetup } from './setup-diagnosis';
import { allowedRepairs } from './setup-agent';
import type { RepairAction } from '@shared/setup-diagnosis';
import { setupFailure, LocalSetup } from './local-setup';
import { ManagedGrobid } from './setup-container';
import { downloadInstaller } from './setup-download';
import { checkDocker, GROBID_IMAGE, type StartGrobidResult } from './docker';
import {
  desktopExecutable,
  dockerExecutable,
  hostArchitecture,
  installerUrl,
  localDockerArgs,
  runSetupCommand,
} from './setup-platform';

export async function createLocalSetup(
  healthy: () => Promise<boolean>,
  publish: (state: SetupState) => void,
  canRestart: () => boolean = () => true,
) {
  const dir = join(app.getPath('userData'), 'local-setup');
  const marker = join(dir, 'preferences.json');
  const arch = await hostArchitecture();
  const path = join(
    dir,
    process.platform === 'darwin' ? 'Docker.dmg' : 'Docker Desktop Installer.exe',
  );
  let installerVerified = false;
  let auxiliaryBusy = false;
  const docker = (
    args: string[],
    signal: AbortSignal,
    timeout = 15_000,
    output?: (text: string) => void,
  ) => runSetupCommand(dockerExecutable(), localDockerArgs(args), signal, timeout, output);
  const container = new ManagedGrobid(docker);
  const openDocker = async (): Promise<void> => {
    const executable = desktopExecutable();
    if (!executable)
      throw new Error(
        'Docker를 아직 찾을 수 없습니다. 설치 창에서 설치를 마친 뒤 다시 눌러주세요.',
      );
    const error = await shell.openPath(executable);
    if (error)
      throw new Error(
        'Docker 창을 열지 못했습니다. 응용 프로그램 또는 시작 메뉴에서 Docker Desktop을 여세요.',
      );
  };
  const openInstaller = async (): Promise<void> => {
    if (!installerVerified)
      throw new Error('“자동 준비 시작”으로 공식 설치 파일을 먼저 받아주세요.');
    const error = await shell.openPath(path);
    if (error) throw new Error('설치 파일을 열지 못했습니다. “자동 준비 시작”을 다시 눌러주세요.');
  };
  const setup = new LocalSetup({
    platform: process.platform,
    arch,
    memoryGB: Math.round(totalmem() / 1024 ** 3),
    installed: () => desktopExecutable() !== null,
    check: () => checkDocker(),
    download: async (signal, progress) => {
      await mkdir(dir, { recursive: true });
      const disk = await statfs(dir);
      if (disk.bavail * disk.bsize < 10 * 1024 ** 3) throw new Error('ENOSPC');
      installerVerified = false;
      await downloadInstaller(
        installerUrl(process.platform, arch),
        path,
        AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]),
        progress,
        net.fetch.bind(net),
      );
      installerVerified = true;
    },
    openInstaller,
    openDocker,
    pull: async (signal, progress) => {
      let last = 0;
      await docker(
        ['pull', '--platform', 'linux/amd64', GROBID_IMAGE],
        signal,
        30 * 60_000,
        (line) => {
          if (Date.now() - last < 1000) return;
          last = Date.now();
          // Only application-written summaries reach the UI/GPT, not raw daemon output.
          progress(
            /extract/i.test(line)
              ? '받은 분석기 파일을 풀고 있습니다. 잠시 기다려주세요.'
              : '논문 분석기 파일을 받고 있습니다. 완료된 파일은 다음 시도에도 재사용합니다.',
          );
        },
      );
    },
    start: (signal) => container.start(signal),
    healthy,
    remember: async (enabled) => {
      await mkdir(dir, { recursive: true });
      await writeFile(marker, JSON.stringify({ autoStart: enabled }), { mode: 0o600 });
    },
    delay: (signal) => delay(5000, undefined, { signal }),
    publish,
  });
  const runtime = {
    setup,
    diagnose: (signal: AbortSignal) =>
      diagnoseSetup(setup.read(), app.getPath('userData'), healthy, signal),
    waitForSetup: async (signal: AbortSignal): Promise<void> => {
      await setup.settled();
      signal.throwIfAborted();
    },
    executeRepair: async (action: RepairAction, signal: AbortSignal): Promise<string> => {
      const latest = await runtime.diagnose(signal);
      if (!allowedRepairs(latest).includes(action))
        return '상태가 바뀌어 조치를 실행하지 않았습니다.';
      try {
        if (action === 'restart_grobid') {
          if (!canRestart()) return '논문을 분석 중이므로 재시작하지 않았습니다.';
          await container.restart(signal);
          await setup.prepare(false);
          await runtime.waitForSetup(signal);
        } else if (action === 'prepare') {
          await setup.prepare();
          await runtime.waitForSetup(signal);
        } else if (action === 'open_docker' || action === 'install_wsl') {
          await runtime.action(action, signal);
          await delay(5000, undefined, { signal });
        }
        signal.throwIfAborted();
        return setup.read().errorCode
          ? `준비 오류: ${setup.read().errorCode}`
          : '요청한 조치를 실행했습니다. 완료 여부는 재진단으로 확인하세요.';
      } catch (error) {
        signal.throwIfAborted();
        return setupFailure(error).message;
      }
    },
    startExisting: async (): Promise<StartGrobidResult> => {
      if (setup.read().busy)
        return {
          started: false,
          message:
            '읽기 환경 준비가 진행 중입니다. 상단 “읽기 환경 준비”에서 완료를 기다린 뒤 PDF를 다시 여세요.',
        };
      const status = await checkDocker();
      if (!status.ok || status.imagePresent !== true || !desktopExecutable())
        return {
          started: false,
          message: '상단 “읽기 환경 준비”에서 자동 준비를 마친 뒤 PDF를 다시 여세요.',
        };
      await setup.prepare(false);
      return { started: true, message: '분석기를 시작하고 있습니다.' };
    },
    resume: async (): Promise<void> => {
      const prefs = await readFile(marker, 'utf8')
        .then((raw) => JSON.parse(raw) as { autoStart?: boolean })
        .catch(() => null);
      if (prefs?.autoStart) await setup.resume();
    },
    action: async (
      action: SetupAction,
      signal: AbortSignal = new AbortController().signal,
    ): Promise<SetupState> => {
      if (action === 'prepare') return setup.prepare();
      if (action === 'cancel') return setup.cancel();
      if (auxiliaryBusy) return setup.read();
      auxiliaryBusy = true;
      try {
        if (action === 'open_docker') await openDocker();
        if (action === 'open_installer') await openInstaller();
        if (action === 'install_wsl') {
          if (process.platform !== 'win32') throw new Error('Windows에서만 사용할 수 있습니다.');
          // A fixed, visible elevated action. Never accept a command from the renderer or GPT.
          await runSetupCommand(
            'powershell.exe',
            [
              '-NoProfile',
              '-Command',
              "Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoProfile', '-NoExit', '-Command', 'wsl.exe --install --no-distribution; wsl.exe --update'",
            ],
            AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
            60_000,
          );
        }
        return setup.read();
      } finally {
        auxiliaryBusy = false;
      }
    },
    close: async (): Promise<void> => {
      // Preserve the user's automatic-start preference when quitting.
      // Cancel only the in-flight setup; stop only the container explicitly managed by PaperLens.
      setup.abort();
      await setup.settled();
      await container.stop();
    },
  };
  return runtime;
}
