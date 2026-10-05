import { execFile } from 'node:child_process';
import { dockerExecutable, localDockerArgs } from './setup-platform';

/**
 * Docker 상태 확인(COMMIT_PLAN C5.1). `docker` 명령으로 데몬이 응답하는지, GROBID 이미지와 컨테이너가 있는지 본다.
 * 설치나 내려받기는 하지 않는다. 이미 있는 이미지로 컨테이너를 띄우는 것만 한다(사용자가 단추를 눌렀을 때).
 * 명령은 고정 인자로만 실행한다. 사용자 입력이 명령에 들어가지 않는다.
 */
export const GROBID_IMAGE = 'grobid/grobid:0.9.1-crf';
export const GROBID_CONTAINER = 'paperlens-grobid';
/** Project only lifecycle facts: full inspect output may exceed command limits and contains environment secrets. */
export const GROBID_INSPECT_FORMAT =
  '[{"Id":{{json .Id}},"Config":{"Image":{{json .Config.Image}},"Labels":{"local.paperlens.managed":{{if .Config.Labels}}{{json (index .Config.Labels "local.paperlens.managed")}}{{else}}null{{end}}}},"State":{"Running":{{json .State.Running}},"OOMKilled":{{json .State.OOMKilled}},"ExitCode":{{json .State.ExitCode}}},"HostConfig":{"PortBindings":{{json .HostConfig.PortBindings}}}}]';
/** 터미널에서 직접 띄울 때의 명령. 점검 화면의 안내문에 쓴다. */
export const GROBID_RUN_ARGS = [
  'run',
  '-d',
  '--platform',
  'linux/amd64',
  '--rm',
  '--init',
  '--ulimit',
  'core=0',
  '-m',
  '4g',
  '-p',
  '127.0.0.1:8070:8070',
  '--name',
  GROBID_CONTAINER,
  GROBID_IMAGE,
];

export interface DockerStatus {
  /** docker 명령이 있고 데몬이 응답하는지 */
  ok: boolean;
  /** not_installed: 명령이 없음. not_running: 명령은 있으나 데몬이 응답하지 않음 */
  reason: 'ok' | 'not_installed' | 'not_running' | 'error';
  message: string;
  /** GROBID 이미지가 내려받아져 있는지. docker가 안 되면 null */
  imagePresent: boolean | null;
  /** 이 앱 이름의 GROBID 컨테이너가 돌고 있는지 */
  containerRunning: boolean | null;
}

export type Exec = (
  file: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ stdout: string; code: number | null; error: NodeJS.ErrnoException | null }>;

export const execDocker: Exec = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      file === 'docker' ? dockerExecutable() : file,
      file === 'docker' ? localDockerArgs(args) : args,
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        const err = error as NodeJS.ErrnoException | null;
        resolve({
          stdout: String(stdout ?? ''),
          code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
          error: err,
        });
      },
    );
  });

export async function checkDocker(
  exec: Exec = execDocker,
  timeoutMs = 5_000,
): Promise<DockerStatus> {
  const info = await exec('docker', ['info', '--format', '{{.ServerVersion}}'], timeoutMs);
  if (info.error) {
    if (info.error.code === 'ENOENT') {
      return {
        ok: false,
        reason: 'not_installed',
        message: 'docker 명령을 찾을 수 없습니다',
        imagePresent: null,
        containerRunning: null,
      };
    }
    return {
      ok: false,
      reason: 'not_running',
      message: `Docker 데몬이 응답하지 않습니다: ${info.error.message.split('\n')[0] ?? ''}`,
      imagePresent: null,
      containerRunning: null,
    };
  }
  const version = info.stdout.trim();
  const images = await exec(
    'docker',
    ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'],
    timeoutMs,
  );
  const imagePresent = images.error
    ? null
    : images.stdout
        .split('\n')
        .map((s) => s.trim())
        .includes(GROBID_IMAGE);
  const ps = await exec('docker', ['ps', '--format', '{{.Names}}'], timeoutMs);
  const containerRunning = ps.error
    ? null
    : ps.stdout
        .split('\n')
        .map((s) => s.trim())
        .includes(GROBID_CONTAINER);
  return {
    ok: true,
    reason: 'ok',
    message: version === '' ? 'Docker 실행 중' : `Docker ${version} 실행 중`,
    imagePresent,
    containerRunning,
  };
}

export interface StartGrobidResult {
  started: boolean;
  message: string;
}

/** 이미 받아 둔 GROBID 이미지로 컨테이너를 띄운다. 이미지가 없으면 내려받지 않고 안내만 돌려준다. */
export async function startGrobidContainer(
  exec: Exec = execDocker,
  timeoutMs = 20_000,
): Promise<StartGrobidResult> {
  const status = await checkDocker(exec, timeoutMs);
  if (!status.ok) return { started: false, message: status.message };
  if (status.containerRunning)
    return { started: true, message: '이미 돌고 있습니다. 준비되기까지 수십 초 걸릴 수 있습니다' };
  if (status.imagePresent === false) {
    return {
      started: false,
      message: `GROBID 이미지가 없습니다. 터미널에서 docker pull ${GROBID_IMAGE} 로 받은 뒤 다시 시도하세요`,
    };
  }
  const run = await exec('docker', GROBID_RUN_ARGS, timeoutMs);
  if (run.error) {
    return {
      started: false,
      message: `GROBID를 띄우지 못했습니다: ${run.error.message.split('\n')[0] ?? ''}`,
    };
  }
  return { started: true, message: 'GROBID를 띄웠습니다. 준비되기까지 수십 초 걸립니다' };
}
