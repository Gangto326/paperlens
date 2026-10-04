import type { LlmJobEvent, LlmJobRequest, LlmJobResult, LlmJobRunner } from './job';

/**
 * 네트워크·서버 오류 재시도(PLAN 10절, COMMIT_PLAN C5.3). 어댑터를 감싸 `failed`(런타임이 턴을 실패로 끝낸 것:
 * 서버 과부하, 연결 끊김 등)만 5초·15초·45초 뒤에 다시 보낸다. 지연에는 무작위 폭(jitter)을 더한다.
 * - 로그인·한도·중단·출력 문제는 다시 보내도 같으므로 그대로 돌려준다. 호출자가 처리한다.
 * - `transport`(App Server 종료)는 다시 보내지 않는다. 런타임을 다시 띄워야 한다.
 * - 기다리는 동안 `shouldContinue()`가 false가 되면(멈춤 요청) 마지막 결과를 그대로 돌려준다.
 * - 같은 jobId로 다시 보낸다. 어댑터는 끝난 작업의 id를 다시 받을 수 있다.
 * 다시 보낸 요청의 사용량은 결과에 합산한다(logicalJobs·turnCount·토큰·시간).
 */
export const RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 45_000];
export const RETRY_JITTER_RATIO = 0.2;

export interface RetryingRunnerDeps {
  inner: LlmJobRunner;
  onRetry?: (jobId: string, attempt: number, delayMs: number) => void;
  delaysMs?: readonly number[];
  shouldContinue?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: (line: string) => void;
}

const addUsage = (a: LlmJobResult['usage'], b: LlmJobResult['usage']): LlmJobResult['usage'] => {
  const sum = (x: number | null | undefined, y: number | null | undefined): number | null =>
    x == null && y == null ? null : (x ?? 0) + (y ?? 0);
  return {
    logicalJobs: a.logicalJobs + b.logicalJobs,
    turnCount: a.turnCount + b.turnCount,
    reportedModelCalls: sum(a.reportedModelCalls, b.reportedModelCalls),
    inputTokens: sum(a.inputTokens, b.inputTokens),
    cachedInputTokens: sum(a.cachedInputTokens, b.cachedInputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    reasoningTokens: sum(a.reasoningTokens, b.reasoningTokens),
    elapsedMs: a.elapsedMs + b.elapsedMs,
  };
};

export class RetryingJobRunner implements LlmJobRunner {
  private readonly delays: readonly number[];
  private readonly shouldContinue: () => boolean;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: RetryingRunnerDeps) {
    this.delays = deps.delaysMs ?? RETRY_DELAYS_MS;
    this.shouldContinue = deps.shouldContinue ?? (() => true);
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = deps.random ?? Math.random;
    this.log = deps.log ?? (() => undefined);
  }

  async run(request: LlmJobRequest, onEvent?: (event: LlmJobEvent) => void): Promise<LlmJobResult> {
    let result = await this.deps.inner.run(request, onEvent);
    let spent = result.usage;
    for (let attempt = 0; attempt < this.delays.length; attempt += 1) {
      if (result.ok || result.kind !== 'failed') break;
      if (!this.shouldContinue()) {
        this.log(`job ${request.jobId} 멈춤 요청으로 다시 보내지 않음`);
        break;
      }
      const base = this.delays[attempt] ?? 0;
      const jitter = Math.round(base * RETRY_JITTER_RATIO * (this.random() * 2 - 1));
      const delay = Math.max(0, base + jitter);
      this.log(
        `job ${request.jobId} 실패(${result.message.split('\n')[0] ?? ''}) → ${delay}ms 뒤 다시 보냄 (${attempt + 1}/${this.delays.length})`,
      );
      this.deps.onRetry?.(request.jobId, attempt + 1, delay);
      await this.sleep(delay);
      if (!this.shouldContinue()) break;
      result = await this.deps.inner.run(request, onEvent);
      spent = addUsage(spent, result.usage);
    }
    return { ...result, usage: spent };
  }

  cancel(jobId: string): ReturnType<LlmJobRunner['cancel']> {
    return this.deps.inner.cancel(jobId);
  }

  activeJobIds(): string[] {
    return this.deps.inner.activeJobIds();
  }
}
