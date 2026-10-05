import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function dockerLocations(
  platform = process.platform,
  home = homedir(),
  env = process.env,
): string[] {
  if (platform === 'darwin')
    return [
      '/Applications/Docker.app/Contents/Resources/bin/docker',
      join(home, 'Applications/Docker.app/Contents/Resources/bin/docker'),
      join(home, '.docker/bin/docker'),
      '/usr/local/bin/docker',
      '/opt/homebrew/bin/docker',
    ];
  if (platform === 'win32')
    return [
      join(
        env['LOCALAPPDATA'] ?? join(home, 'AppData/Local'),
        'Programs/DockerDesktop/resources/bin/docker.exe',
      ),
      join(
        env['LOCALAPPDATA'] ?? join(home, 'AppData/Local'),
        'Programs/Docker/Docker/resources/bin/docker.exe',
      ),
      join(env['ProgramFiles'] ?? 'C:\\Program Files', 'Docker/Docker/resources/bin/docker.exe'),
    ];
  return ['/usr/bin/docker', '/usr/local/bin/docker'];
}
export function dockerExecutable(): string {
  return dockerLocations().find(existsSync) ?? 'docker';
}
export function desktopExecutable(): string | null {
  const paths =
    process.platform === 'darwin'
      ? ['/Applications/Docker.app', join(homedir(), 'Applications/Docker.app')]
      : [
          join(process.env['LOCALAPPDATA'] ?? '', 'Programs/DockerDesktop/Docker Desktop.exe'),
          join(process.env['LOCALAPPDATA'] ?? '', 'Programs/Docker/Docker/Docker Desktop.exe'),
          join(
            process.env['ProgramFiles'] ?? 'C:\\Program Files',
            'Docker/Docker/Docker Desktop.exe',
          ),
        ];
  return paths.find(existsSync) ?? null;
}
/** A packaged Intel Electron may run under Rosetta on an Apple silicon Mac. */
export async function hostArchitecture(): Promise<string> {
  if (
    process.platform === 'win32' &&
    [process.env['PROCESSOR_ARCHITEW6432'], process.env['PROCESSOR_ARCHITECTURE']].some(
      (value) => value?.toLowerCase() === 'arm64',
    )
  )
    return 'arm64';
  if (process.platform !== 'darwin') return process.arch;
  return new Promise((resolve) =>
    execFile('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { timeout: 3000 }, (_err, stdout) =>
      resolve(stdout.trim() === '1' ? 'arm64' : process.arch),
    ),
  );
}
export function installerUrl(platform: string, arch: string): string {
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) {
    return `https://desktop.docker.com/mac/main/${arch === 'x64' ? 'amd64' : 'arm64'}/Docker.dmg`;
  }
  if (platform === 'win32' && arch === 'x64')
    return 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe';
  throw new Error('unsupported_platform');
}
/** Commands only target the local Docker Desktop endpoint; never inherit a remote context. */
export function localDockerArgs(args: string[]): string[] {
  if (process.platform === 'win32') return ['--host', 'npipe:////./pipe/docker_engine', ...args];
  const socket = join(homedir(), '.docker/run/docker.sock');
  return ['--host', `unix://${existsSync(socket) ? socket : '/var/run/docker.sock'}`, ...args];
}
export async function runSetupCommand(
  file: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs: number,
  onOutput: (text: string) => void = () => undefined,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    });
    let tail = '';
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('command_timeout'));
    }, timeoutMs);
    const append = (data: Buffer): void => {
      const text = data.toString();
      tail = (tail + text).slice(-8000);
      onOutput(text);
    };
    child.stdout.on('data', (data: Buffer) => {
      stdout = (stdout + data.toString()).slice(-8000);
      append(data);
    });
    child.stderr.on('data', append);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(tail || 'command_failed'));
    });
  });
}
