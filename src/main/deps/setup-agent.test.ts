import { describe, expect, it, vi } from 'vitest';
import type { SetupDiagnosis, RepairAction } from '@shared/setup-diagnosis';
import type { LlmJobRequest, LlmJobRunner } from '../llm/job';
import { allowedRepairs, SetupAgent, type SetupAgentHost } from './setup-agent';

const diagnosis = (): SetupDiagnosis => ({
  checkedAt: '2026-10-04T00:00:00Z',
  platform: 'darwin',
  arch: 'arm64',
  osVersion: '25',
  memoryGB: 16,
  freeDiskGB: 30,
  desktopInstalled: false,
  docker: { reachable: false, engine: 'unknown', imagePresent: null },
  container: {
    exists: false,
    managed: false,
    compatible: false,
    running: false,
    oomKilled: false,
    exitCode: null,
  },
  grobidHealthy: false,
  portOpen: false,
  wsl: 'not_applicable',
  virtualization: 'unknown',
  signals: [],
  setupPhase: 'idle',
  setupBusy: false,
  setupError: null,
});
function fixture(action: RepairAction = 'prepare') {
  let current = diagnosis();
  const run = vi.fn((_request: LlmJobRequest) =>
    Promise.resolve({ ok: true, value: { action, explanation: '필요한 준비를 진행하겠습니다.' } }),
  );
  const cancel = vi.fn(() => Promise.resolve());
  const runner = { run, cancel } as unknown as LlmJobRunner;
  const host: SetupAgentHost = {
    diagnose: vi.fn(() => Promise.resolve(current)),
    execute: vi.fn(() => {
      current = { ...current, grobidHealthy: true };
      return Promise.resolve('조치 실행');
    }),
    waitForSetup: () => Promise.resolve(),
    cancel,
    publish: vi.fn(),
  };
  return {
    runner,
    run,
    host,
    current: (value: SetupDiagnosis) => {
      current = value;
    },
  };
}
describe('Codex diagnostic repair loop', () => {
  it('measures, decides, executes and verifies actual readiness without another click', async () => {
    const f = fixture();
    const agent = new SetupAgent(f.runner, f.host);
    agent.start('설치를 맡길게요', true);
    agent.start('중복 클릭', true);
    await agent.settled();
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.run.mock.calls[0]?.[0].prompt).toContain('freeDiskGB');
    expect(f.host.execute).toHaveBeenCalledOnce();
    expect(agent.read()).toMatchObject({
      phase: 'ready',
      busy: false,
      history: [{ action: 'prepare', result: '조치 실행' }],
    });
  });
  it('refuses missing consent before collecting or transmitting anything', () => {
    const f = fixture();
    const agent = new SetupAgent(f.runner, f.host);
    expect(() => agent.start('', false)).toThrow('동의');
    expect(f.host.diagnose).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });
  it('does not trust a model claiming completion when health checks fail', async () => {
    const f = fixture('done');
    const agent = new SetupAgent(f.runner, f.host);
    agent.start('', true);
    await agent.settled();
    expect(agent.read().phase).toBe('waiting_user');
    expect(f.host.execute).not.toHaveBeenCalled();
  });
  it('revalidates changed state before a mutation', async () => {
    const f = fixture();
    f.run.mockImplementation(() => {
      f.current({ ...diagnosis(), freeDiskGB: 1 });
      return Promise.resolve({
        ok: true,
        value: { action: 'prepare', explanation: '설치합니다.' },
      });
    });
    const agent = new SetupAgent(f.runner, f.host);
    agent.start('', true);
    await agent.settled();
    expect(f.host.execute).not.toHaveBeenCalled();
    expect(agent.read().phase).toBe('waiting_user');
  });
  it('cancellation stops a pending decision and prevents any late action', async () => {
    const f = fixture();
    let release!: () => void;
    f.run.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ ok: true, value: { action: 'prepare', explanation: '설치합니다.' } });
        }),
    );
    const agent = new SetupAgent(f.runner, f.host);
    agent.start('', true);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce());
    const stopped = agent.cancel();
    release();
    await stopped;
    expect(agent.read().phase).toBe('cancelled');
    expect(f.host.execute).not.toHaveBeenCalled();
    expect(f.host.cancel).toHaveBeenCalledWith(false);
  });
  it('bounds repeated failed repairs', async () => {
    const f = fixture();
    f.host.execute = vi.fn(() => Promise.resolve('네트워크 오류'));
    const agent = new SetupAgent(f.runner, f.host);
    agent.start('', true);
    await agent.settled();
    expect(f.host.execute).toHaveBeenCalledTimes(2);
    expect(agent.read().phase).toBe('waiting_user');
  });
  it('provides a fallback when model access fails', async () => {
    const f = fixture();
    f.run.mockRejectedValue(new Error('private diagnostic details'));
    const agent = new SetupAgent(f.runner, f.host);
    agent.start('', true);
    await agent.settled();
    expect(agent.read()).toMatchObject({ phase: 'error', busy: false });
    expect(agent.read().message).not.toContain('private');
    expect(f.host.execute).not.toHaveBeenCalled();
  });
  it('never restarts an unrelated container or runs WSL on a Mac', () => {
    expect(allowedRepairs(diagnosis())).not.toContain('install_wsl');
    expect(
      allowedRepairs({ ...diagnosis(), platform: 'win32', arch: 'x64', wsl: 'unavailable' }),
    ).toContain('install_wsl');
    expect(
      allowedRepairs({
        ...diagnosis(),
        container: { ...diagnosis().container, exists: true, running: true },
      }),
    ).toEqual(['wait_user']);
    expect(allowedRepairs({ ...diagnosis(), virtualization: 'disabled' })).toEqual(['wait_user']);
  });
});
