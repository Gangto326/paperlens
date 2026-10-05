import { release } from 'node:os';
import { statfs } from 'node:fs/promises';
import { createConnection } from 'node:net';
import type { SetupDiagnosis } from '@shared/setup-diagnosis';
import type { SetupState } from '@shared/local-setup';
import {
  desktopExecutable,
  dockerExecutable,
  localDockerArgs,
  runSetupCommand,
} from './setup-platform';
import { GROBID_CONTAINER, GROBID_IMAGE, GROBID_INSPECT_FORMAT } from './docker';

/** Only known diagnostic facts leave this module. Never send raw inspect JSON, paths or log lines. */
export function diagnosticSignals(raw: string): string[] {
  raw = raw.replace(/\0/g, '');
  const rules: Array<[string, RegExp]> = [
    [
      'out_of_memory',
      /out of memory|outofmemoryerror|oom[- ]kill|cannot allocate memory|java heap space/i,
    ],
    ['disk_full', /no space left|ENOSPC/i],
    ['port_conflict', /address already in use|port[^\n]*(?:allocated|in use)/i],
    ['architecture_mismatch', /exec format error|no matching manifest/i],
    [
      'virtualization_disabled',
      /0x80370102|HCS_E_HYPERV_NOT_INSTALLED|virtualization.*(?:disabled|not enabled)/i,
    ],
    [
      'wsl_update_required',
      /WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED|WSL_E_OLD_KERNEL|0x800701bc|wsl.*(?:update|upgrade).*required/i,
    ],
    [
      'network_error',
      /no such host|network is unreachable|TLS handshake timeout|proxyconnect|certificate.*(?:unknown|expired)/i,
    ],
    ['permission_denied', /permission denied|access is denied|EACCES/i],
  ];
  return rules.filter(([, expression]) => expression.test(raw)).map(([code]) => code);
}
export function containerFacts(raw: string): SetupDiagnosis['container'] {
  const empty = {
    exists: null,
    managed: false,
    compatible: false,
    running: false,
    oomKilled: false,
    exitCode: null,
  };
  try {
    const items = JSON.parse(raw) as Array<{
      Config?: { Image?: string; Labels?: Record<string, string> };
      State?: { Running?: boolean; OOMKilled?: boolean; ExitCode?: number };
      HostConfig?: { PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }>> };
    }>;
    const item = items[0];
    if (!item) return empty;
    const ports = item.HostConfig?.PortBindings?.['8070/tcp'];
    return {
      exists: true,
      managed: item.Config?.Labels?.['local.paperlens.managed'] === '1',
      compatible:
        item.Config?.Image === GROBID_IMAGE &&
        ports?.length === 1 &&
        ports[0]?.HostIp === '127.0.0.1' &&
        ports[0]?.HostPort === '8070',
      running: item.State?.Running === true,
      oomKilled: item.State?.OOMKilled === true,
      exitCode: typeof item.State?.ExitCode === 'number' ? item.State.ExitCode : null,
    };
  } catch {
    return empty;
  }
}
function portOpen(signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: 8070 });
    const end = (value: boolean): void => {
      signal.removeEventListener('abort', cancel);
      socket.destroy();
      resolve(value);
    };
    const cancel = (): void => end(false);
    socket.setTimeout(2000);
    socket.once('connect', () => end(true));
    socket.once('error', () => end(false));
    socket.once('timeout', () => end(false));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}
export async function diagnoseSetup(
  state: SetupState,
  dataDir: string,
  healthy: () => Promise<boolean>,
  signal: AbortSignal,
): Promise<SetupDiagnosis> {
  const signals = new Set<string>();
  const command = async (
    file: string,
    args: string[],
    collectLogSignals = false,
  ): Promise<string | null> => {
    try {
      let output = '';
      const result = await runSetupCommand(file, args, signal, 8000, (chunk) => {
        output = (output + chunk).slice(-8000);
      });
      if (collectLogSignals) for (const code of diagnosticSignals(output)) signals.add(code);
      return result.replace(/\0/g, '');
    } catch (error) {
      signal.throwIfAborted();
      for (const code of diagnosticSignals(String(error))) signals.add(code);
      return null;
    }
  };
  const docker = (args: string[], collectLogSignals = false) =>
    command(dockerExecutable(), localDockerArgs(args), collectLogSignals);
  const [info, disk, alive, port, wsl, virtualization] = await Promise.all([
    docker(['info', '--format', '{{.OSType}}']),
    statfs(dataDir)
      .then((s) => Math.floor((s.bavail * s.bsize) / 1024 ** 3))
      .catch(() => null),
    healthy().catch(() => false),
    portOpen(signal),
    state.platform === 'win32'
      ? command('wsl.exe', ['--status'])
      : Promise.resolve('not_applicable'),
    state.platform === 'win32'
      ? command('powershell.exe', [
          '-NoProfile',
          '-Command',
          '$h = (Get-CimInstance Win32_ComputerSystem).HypervisorPresent; $v = @(Get-CimInstance Win32_Processor | Where-Object VirtualizationFirmwareEnabled).Count -gt 0; if ($h -or $v) { "enabled" } else { "disabled" }',
        ])
      : Promise.resolve('unknown'),
  ]);
  let container = containerFacts('');
  let imagePresent: boolean | null = null;
  if (info !== null) {
    const [images, names] = await Promise.all([
      docker(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']),
      docker(['ps', '-a', '--filter', `name=^/${GROBID_CONTAINER}$`, '--format', '{{.Names}}']),
    ]);
    imagePresent =
      images === null
        ? null
        : images
            .split('\n')
            .map((s) => s.trim())
            .includes(GROBID_IMAGE);
    if (names?.trim() === GROBID_CONTAINER) {
      container = containerFacts(
        (await docker(['inspect', '--format', GROBID_INSPECT_FORMAT, GROBID_CONTAINER])) ?? '',
      );
      // Inspect only this app's compatible container, never logs belonging to another application.
      if (container.managed && container.compatible) {
        const logs = await docker(
          ['logs', '--tail', '60', '--since', '10m', GROBID_CONTAINER],
          true,
        );
        for (const code of diagnosticSignals(logs ?? '')) signals.add(code);
      }
    } else if (names !== null) container = { ...container, exists: false };
  }
  signal.throwIfAborted();
  return {
    checkedAt: new Date().toISOString(),
    platform: state.platform,
    arch: state.arch,
    osVersion: release(),
    memoryGB: state.memoryGB,
    freeDiskGB: disk,
    desktopInstalled: desktopExecutable() !== null,
    docker: {
      reachable: info !== null,
      engine:
        info?.trim() === 'linux' ? 'linux' : info?.trim() === 'windows' ? 'windows' : 'unknown',
      imagePresent,
    },
    container,
    grobidHealthy: alive,
    portOpen: port,
    wsl: state.platform !== 'win32' ? 'not_applicable' : wsl !== null ? 'ready' : 'unavailable',
    virtualization:
      virtualization?.trim() === 'enabled'
        ? 'enabled'
        : virtualization?.trim() === 'disabled'
          ? 'disabled'
          : 'unknown',
    signals: [...signals],
    setupPhase: state.phase,
    setupBusy: state.busy,
    setupError: state.errorCode,
  };
}
