import type { Usage } from '@shared/schema';

const addNullable = (a: number | null | undefined, b: number | null | undefined): number | null => {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return a + b;
};

/** 사용량 합산. 토큰 값은 한쪽이 없으면 있는 쪽 값을 쓴다(모르는 값을 0으로 치지 않는다). */
export function addUsage(total: Usage, job: Usage): Usage {
  return {
    logicalJobs: total.logicalJobs + job.logicalJobs,
    turnCount: total.turnCount + job.turnCount,
    reportedModelCalls: addNullable(total.reportedModelCalls, job.reportedModelCalls),
    inputTokens: addNullable(total.inputTokens, job.inputTokens),
    cachedInputTokens: addNullable(total.cachedInputTokens, job.cachedInputTokens),
    outputTokens: addNullable(total.outputTokens, job.outputTokens),
    reasoningTokens: addNullable(total.reasoningTokens, job.reasoningTokens),
    elapsedMs: total.elapsedMs + job.elapsedMs,
  };
}
