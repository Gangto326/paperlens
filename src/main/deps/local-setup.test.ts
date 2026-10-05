import { describe, expect, it, vi } from 'vitest';
import { LocalSetup, setupFailure, type SetupHost } from './local-setup';

function host(overrides: Partial<SetupHost> = {}): SetupHost {
  return {
    platform: 'darwin',
    arch: 'arm64',
    memoryGB: 16,
    installed: vi.fn(() => true),
    check: vi.fn(() =>
      Promise.resolve({
        ok: true,
        reason: 'ok' as const,
        message: '',
        imagePresent: true,
        containerRunning: false,
      }),
    ),
    download: vi.fn(() => Promise.resolve(undefined)),
    openInstaller: vi.fn(() => Promise.resolve(undefined)),
    openDocker: vi.fn(() => Promise.resolve(undefined)),
    pull: vi.fn(() => Promise.resolve(undefined)),
    start: vi.fn(() => Promise.resolve(undefined)),
    healthy: vi.fn(() => Promise.resolve(true)),
    remember: vi.fn(() => Promise.resolve(undefined)),
    delay: vi.fn(() => Promise.resolve(undefined)),
    publish: vi.fn(),
    ...overrides,
  };
}
describe('local setup lifecycle', () => {
  it('reuses installed dependencies, coalesces clicks, remembers consent', async () => {
    const h = host();
    const setup = new LocalSetup(h);
    await Promise.all([setup.prepare(), setup.prepare()]);
    await setup.settled();
    expect(h.download).not.toHaveBeenCalled();
    expect(h.pull).not.toHaveBeenCalled();
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.remember).toHaveBeenCalledWith(true);
    expect(setup.read()).toMatchObject({ phase: 'ready', busy: false, autoStart: true });
  });
  it('manual PDF startup preserves the disabled automatic-start preference', async () => {
    const h = host();
    const setup = new LocalSetup(h);
    await setup.prepare(false);
    await setup.settled();
    expect(h.remember).not.toHaveBeenCalled();
    expect(setup.read()).toMatchObject({ phase: 'ready', autoStart: false });
  });
  it('waits for user installation and Docker before downloading and starting GROBID', async () => {
    let installed = false;
    let running = false;
    const h = host({
      installed: () => installed,
      openInstaller: vi.fn(() => {
        installed = true;
        return Promise.resolve();
      }),
      openDocker: vi.fn(() => {
        running = true;
        return Promise.resolve();
      }),
      check: () =>
        Promise.resolve({
          ok: running,
          reason: running ? 'ok' : 'not_running',
          message: '',
          imagePresent: false,
          containerRunning: false,
        }),
    });
    const setup = new LocalSetup(h);
    await setup.prepare();
    await setup.settled();
    expect(h.download).toHaveBeenCalledOnce();
    expect(h.openInstaller).toHaveBeenCalledOnce();
    expect(h.openDocker).toHaveBeenCalledOnce();
    expect(h.pull).toHaveBeenCalledOnce();
    expect(setup.read().phase).toBe('ready');
  });
  it('cancels downloads without opening installer and allows a later retry', async () => {
    const h = host({
      installed: () => false,
      download: vi.fn(
        (signal: AbortSignal) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('abort')), { once: true });
          }),
      ),
    });
    const setup = new LocalSetup(h);
    await setup.prepare();
    await setup.cancel();
    expect(h.openInstaller).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
    expect(setup.read()).toMatchObject({ phase: 'cancelled', busy: false, autoStart: false });
    expect(h.remember).toHaveBeenLastCalledWith(false);
    h.installed = () => true;
    await setup.prepare();
    await setup.settled();
    expect(setup.read().phase).toBe('ready');
  });
  it('does not install unexpectedly on relaunch if Docker was removed', async () => {
    const h = host({ installed: () => false });
    const setup = new LocalSetup(h);
    await setup.resume();
    expect(h.download).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });
  it('bounds unhealthy startup and provides a retry instead of indefinite loading', async () => {
    const h = host({ healthy: () => Promise.resolve(false) });
    const setup = new LocalSetup(h);
    await setup.prepare();
    await setup.settled();
    expect(h.delay).toHaveBeenCalledTimes(60);
    expect(setup.read()).toMatchObject({ phase: 'error', errorCode: 'timeout', busy: false });
  });
  it('rejects unsupported hardware before any download', async () => {
    const h = host({ platform: 'win32', arch: 'arm64' });
    const setup = new LocalSetup(h);
    await setup.prepare();
    await setup.settled();
    expect(h.remember).not.toHaveBeenCalled();
    expect(h.download).not.toHaveBeenCalled();
    expect(setup.read().errorCode).toBe('unsupported');
  });
  it('never exposes raw command output or private paths in error messages', () => {
    expect(setupFailure(new Error('/Users/private/token secret'))).toMatchObject({
      errorCode: 'setup_failed',
    });
    expect(setupFailure(new Error('checksum_mismatch')).errorCode).toBe('integrity');
    expect(setupFailure(new Error('ENOSPC')).errorCode).toBe('disk');
  });
});
