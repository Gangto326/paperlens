import { describe, expect, it, vi } from 'vitest';
import { SetupAssistant } from './setup-assistant';
import type { LlmJobRunner, LlmJobRequest } from '../llm/job';
import type { SetupState } from '@shared/local-setup';

const state: SetupState = {
  platform: 'darwin',
  arch: 'arm64',
  memoryGB: 16,
  phase: 'error',
  busy: false,
  progress: null,
  errorCode: 'timeout',
  message: 'SECRET RAW LOG',
  autoStart: true,
};
function runner(action: string) {
  const run = vi.fn((_request: LlmJobRequest) =>
    Promise.resolve({
      ok: true,
      value: { explanation: 'Docker 창을 확인하세요.', action },
    }),
  );
  return { run, runner: { run } as unknown as LlmJobRunner };
}
describe('setup GPT assistance', () => {
  it('sends a bounded status, not raw logs; uses no tools and coalesces requests', async () => {
    const fake = runner('open_docker');
    const helper = new SetupAssistant(fake.runner);
    const results = await Promise.all([
      helper.ask(state, '멈췄어요'),
      helper.ask(state, '멈췄어요'),
    ]);
    expect(results[0]?.action).toBe('open_docker');
    expect(fake.run).toHaveBeenCalledOnce();
    const request = fake.run.mock.calls[0]?.[0];
    expect(request?.research).toEqual({ kind: 'none' });
    expect(request?.prompt).not.toContain('SECRET RAW LOG');
    expect(request?.prompt).toContain('timeout');
  });
  it('rejects arbitrary actions and suppresses inappropriate platform actions', async () => {
    await expect(new SetupAssistant(runner('shell').runner).ask(state, '')).rejects.toThrow();
    expect((await new SetupAssistant(runner('install_wsl').runner).ask(state, '')).action).toBe(
      'none',
    );
    expect(
      (await new SetupAssistant(runner('prepare').runner).ask({ ...state, busy: true }, '')).action,
    ).toBe('none');
  });
  it('rejects oversized questions before invoking GPT', async () => {
    const fake = runner('none');
    await expect(new SetupAssistant(fake.runner).ask(state, 'x'.repeat(2001))).rejects.toThrow(
      '2,000',
    );
    expect(fake.run).not.toHaveBeenCalled();
  });
});
