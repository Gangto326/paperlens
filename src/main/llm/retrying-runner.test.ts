import { describe, expect, it } from 'vitest';
import type { LlmJobFailureKind, LlmJobRequest, LlmJobResult, LlmJobRunner } from './job';
import { RETRY_DELAYS_MS, RetryingJobRunner } from './retrying-runner';

const request: LlmJobRequest = {
  jobId: 'j1',
  prompt: 'p',
  outputSchema: {},
  research: { kind: 'none' },
};
const usage = { logicalJobs: 1, turnCount: 1, inputTokens: 10, outputTokens: 1, elapsedMs: 100 };
const failed = (kind: LlmJobFailureKind): LlmJobResult => ({
  ok: false,
  jobId: 'j1',
  kind,
  message: `실패 ${kind}\n자세히`,
  errors: [],
  rawText: null,
  model: null,
  usage,
});
const ok: LlmJobResult = { ok: true, jobId: 'j1', value: 1, rawText: '1', model: 'm', usage };

const scripted = (replies: LlmJobResult[]): LlmJobRunner & { calls: number } => {
  const runner = {
    calls: 0,
    run: () => {
      const reply = replies[Math.min(runner.calls, replies.length - 1)] as LlmJobResult;
      runner.calls += 1;
      return Promise.resolve(reply);
    },
    cancel: (jobId: string) => Promise.resolve({ jobId, status: 'not_found' as const }),
    activeJobIds: () => [],
  };
  return runner;
};

const harness = (replies: LlmJobResult[], shouldContinue = () => true) => {
  const inner = scripted(replies);
  const sleeps: number[] = [];
  const runner = new RetryingJobRunner({
    inner,
    shouldContinue,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
  });
  return { inner, sleeps, runner };
};

describe('RetryingJobRunner', () => {
  it('failed는 5·15·45초 뒤에 최대 3번 다시 보내고 사용량을 합산한다', async () => {
    const h = harness([failed('failed'), failed('failed'), ok]);
    const result = await h.runner.run(request);
    expect(result.ok).toBe(true);
    expect(h.inner.calls).toBe(3);
    expect(h.sleeps).toEqual(RETRY_DELAYS_MS.slice(0, 2));
    expect(result.usage).toMatchObject({
      logicalJobs: 3,
      turnCount: 3,
      inputTokens: 30,
      elapsedMs: 300,
    });

    const never = harness([failed('failed')]);
    const last = await never.runner.run(request);
    expect(last).toMatchObject({ ok: false, kind: 'failed', usage: { logicalJobs: 4 } });
    expect(never.inner.calls).toBe(4);
    expect(never.sleeps).toEqual([...RETRY_DELAYS_MS]);
  });

  it('지연에 무작위 폭을 더한다', async () => {
    const inner = scripted([failed('failed'), ok]);
    const sleeps: number[] = [];
    const runner = new RetryingJobRunner({
      inner,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      random: () => 1,
    });
    await runner.run(request);
    expect(sleeps).toEqual([6_000]);
  });

  it('로그인·한도·중단·출력 문제·transport는 다시 보내지 않는다', async () => {
    for (const kind of [
      'needs_login',
      'quota',
      'cancelled',
      'invalid_json',
      'timeout',
      'transport',
    ] as const) {
      const h = harness([failed(kind), ok]);
      expect(await h.runner.run(request)).toMatchObject({ ok: false, kind });
      expect(h.inner.calls).toBe(1);
      expect(h.sleeps).toEqual([]);
    }
  });

  it('멈춤 요청이 오면 기다리지 않고 마지막 결과를 돌려준다', async () => {
    let go = true;
    const h = harness([failed('failed'), ok], () => go);
    go = false;
    expect(await h.runner.run(request)).toMatchObject({ ok: false, kind: 'failed' });
    expect(h.sleeps).toEqual([]);
  });
});
