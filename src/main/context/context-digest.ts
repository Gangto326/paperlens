import { formatAjvErrors, type Coverage, type SectionDigest, type Usage } from '@shared/schema';
import Ajv from 'ajv';
import { sha256Hex, stableStringify } from '../cache/hash';
import type { LlmJobEvent, LlmJobFailureKind, LlmJobResult, LlmJobRunner } from '../llm/job';
import { addUsage } from '../llm/usage';
import { promptVersionOf, renderPrompt } from '../prompt/template';
import { CONTEXT_DIGEST_TEMPLATE } from '../prompt/templates';
import type { InflightStore } from '../resume/inflight-store';
import { estimateTokens, type ContextBodySection, type ContextInput } from './context-input';
import type { ContextModelCoverage } from './context-output';
import { validateCoverage, type ContextProblem } from './context-validate';

/**
 * 긴 논문의 부분 작업(PLAN 5절, COMMIT_PLAN C3.1). 본문을 부분으로 나누고 부분마다 섹션 요약을 만든다.
 *
 * - 부분은 읽기 순서로 섹션을 이어 담는다. 한 부분의 본문 추정 토큰이 `maxTokens`를 넘지 않게 한다.
 *   섹션 하나가 그보다 길면 문장 경계에서 나눈다. 문장 하나가 그보다 길면 그 문장 하나가 한 부분이다.
 * - 부분 작업은 서로의 결과를 입력으로 받지 않는다. `concurrency`개까지 동시에 돈다(COMMIT_PLAN M3 P1).
 * - 부분마다 coverage 장부를 검사한다. 그 부분의 모든 섹션과 문장이 들어 있어야 한다.
 *   모든 부분이 통과하면 본문의 모든 문장이 적어도 한 부분 작업에 들어간 것이다.
 * - 돌던 작업의 보존(COMMIT_PLAN M3 P2): 부분 작업의 출력은 inflight에 남는다.
 *   다시 실행하면 끝난 부분의 출력을 다시 검증해서 쓰고, 남은 부분만 요청한다.
 *   부분 요약은 통째로 하나의 결과라 끊긴 출력에서 일부만 건지지 않는다.
 * - 로그인 필요, 한도 초과, 런타임 없음이 나오면 새 부분을 보내지 않는다. 돌던 부분은 끝나기를 기다린다.
 */
export const DIGEST_PART_MAX_TOKENS = 12_000;
export const DIGEST_TIMEOUT_MS = 10 * 60_000;
export const DIGEST_CONCURRENCY = 3;

export interface ContextPart {
  /** `part_001`부터 */
  id: string;
  index: number;
  body: ContextBodySection[];
  /** 이 부분에 든 섹션(원래 ID)과 그 문장(원래 ID, 읽기 순서) */
  sections: ContextInput['sections'];
  estimatedTokens: number;
}

export function planParts(input: ContextInput, maxTokens = DIGEST_PART_MAX_TOKENS): ContextPart[] {
  const limit = Math.max(1, Math.floor(maxTokens));
  const parts: ContextPart[] = [];
  let body: ContextBodySection[] = [];
  let sections: ContextInput['sections'] = [];
  let chars = 0;
  const flush = (): void => {
    if (body.length === 0) return;
    const index = parts.length;
    parts.push({
      id: `part_${String(index + 1).padStart(3, '0')}`,
      index,
      body,
      sections,
      estimatedTokens: estimateTokens(chars),
    });
    body = [];
    sections = [];
    chars = 0;
  };
  input.body.forEach((section, i) => {
    const original = input.sections[i];
    if (!original) return;
    let run: ContextBodySection['sentences'] = [];
    let runIds: string[] = [];
    const close = (): void => {
      if (run.length === 0) return;
      body.push({ ...section, sentences: run });
      sections.push({ sectionId: original.sectionId, sentenceIds: runIds });
      run = [];
      runIds = [];
    };
    section.sentences.forEach((sentence, k) => {
      const size = sentence.en.length;
      if (chars > 0 && estimateTokens(chars + size) > limit) {
        close();
        flush();
      }
      run.push(sentence);
      runIds.push(original.sentenceIds[k] ?? sentence.id);
      chars += size;
    });
    close();
  });
  flush();
  return parts;
}

export interface DigestModelOutput {
  digests: {
    sectionId: string;
    summary: string;
    claims: string[];
    termCandidates: string[];
    evidenceSentenceIds: string[];
    unresolved: string[];
  }[];
  coverage: ContextModelCoverage[];
}

const str = { type: 'string' } as const;
const strArr = { type: 'array', items: str } as const;

export const DIGEST_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['digests', 'coverage'],
  properties: {
    digests: {
      type: 'array',
      description: 'PAPER_PART의 섹션마다 하나',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'sectionId',
          'summary',
          'claims',
          'termCandidates',
          'evidenceSentenceIds',
          'unresolved',
        ],
        properties: {
          sectionId: { ...str, description: '입력 섹션의 id 그대로' },
          summary: { ...str, description: '그 섹션이 말하는 바(한국어)' },
          claims: { ...strArr, description: '주장·결과·한계. 하나에 한 가지(한국어)' },
          termCandidates: { ...strArr, description: '"원어: 이 논문에서의 뜻" 꼴의 용어' },
          evidenceSentenceIds: { ...strArr, description: '근거 문장 id. 입력에 있는 id만 쓴다' },
          unresolved: { ...strArr, description: '이 범위만으로는 알 수 없는 것' },
        },
      },
    },
    coverage: {
      type: 'array',
      description: 'PAPER_PART의 모든 섹션에 대해 읽은 문장 범위',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sectionId', 'startSentenceId', 'endSentenceId', 'status'],
        properties: {
          sectionId: str,
          startSentenceId: str,
          endSentenceId: str,
          status: { type: 'string', enum: ['covered', 'partial', 'missing'] },
        },
      },
    },
  },
} as const;

const outputValidator = new Ajv({ allErrors: true, strict: false }).compile<DigestModelOutput>(
  DIGEST_OUTPUT_SCHEMA,
);

export interface ValidatedPart {
  problems: ContextProblem[];
  notes: string[];
  digests: SectionDigest[];
  coverage: Omit<Coverage, 'jobId'>[];
}

const trimAll = (items: readonly string[]): string[] =>
  items.map((s) => s.trim()).filter((s) => s !== '');

/** 부분 작업의 출력 검증. 그 부분의 모든 섹션에 요약이 있고 coverage가 그 부분을 모두 덮어야 한다. */
export function validatePartOutput(
  output: DigestModelOutput,
  part: ContextPart,
  input: ContextInput,
): ValidatedPart {
  const ledger = validateCoverage(output.coverage, part.sections, input.aliases);
  const problems = [...ledger.problems];
  const notes: string[] = [];
  const sentencesOf = new Map(part.sections.map((s) => [s.sectionId, new Set(s.sentenceIds)]));
  const bySection = new Map<string, SectionDigest>();
  for (const digest of output.digests) {
    const sectionId = input.aliases.sectionId(digest.sectionId);
    const own = sectionId === undefined ? undefined : sentencesOf.get(sectionId);
    if (sectionId === undefined || own === undefined) {
      notes.push(`이 부분에 없는 섹션의 요약을 버렸습니다: ${digest.sectionId}`);
      continue;
    }
    if (bySection.has(sectionId)) {
      notes.push(`같은 섹션의 두 번째 요약을 버렸습니다: ${digest.sectionId}`);
      continue;
    }
    const evidence: string[] = [];
    for (const alias of digest.evidenceSentenceIds) {
      const id = input.aliases.sentenceId(alias);
      if (id === undefined || !own.has(id)) {
        notes.push(`섹션 ${digest.sectionId}의 근거 문장 id가 이 부분에 없습니다: ${alias}`);
      } else if (!evidence.includes(id)) evidence.push(id);
    }
    bySection.set(sectionId, {
      sectionId,
      summary: digest.summary.trim(),
      claims: trimAll(digest.claims),
      termCandidates: trimAll(digest.termCandidates),
      evidenceSentenceIds: evidence,
      unresolved: trimAll(digest.unresolved),
    });
  }
  const digests: SectionDigest[] = [];
  for (const section of part.sections) {
    const digest = bySection.get(section.sectionId);
    const alias = input.aliases.sectionAlias(section.sectionId) ?? section.sectionId;
    if (!digest || digest.summary === '') {
      problems.push({
        code: 'section_not_covered',
        message: `섹션 ${alias}의 요약이 없습니다`,
      });
      continue;
    }
    digests.push(digest);
  }
  return { problems, notes, digests, coverage: ledger.coverage };
}

export interface PartReport {
  partId: string;
  jobId: string | null;
  sections: number;
  sentences: number;
  estimatedTokens: number;
  /** reused는 앞선 실행에서 남은 출력을 쓴 부분이다. 모델을 부르지 않았다. */
  outcome: 'ok' | 'reused' | 'llm_failed' | 'output_shape' | 'validation_failed' | 'not_sent';
  llmKind: LlmJobFailureKind | null;
  problems: ContextProblem[];
  usage: Usage | null;
}

export type DigestRunResult =
  | {
      ok: true;
      /** 읽기 순서. 섹션이 두 부분에 걸치면 그 섹션의 요약이 둘이다 */
      digests: SectionDigest[];
      coverage: Coverage[];
      notes: string[];
      parts: PartReport[];
      usage: Usage;
    }
  | {
      ok: false;
      code: 'llm_failed' | 'output_shape' | 'validation_failed';
      message: string;
      llmKind: LlmJobFailureKind | null;
      problems: ContextProblem[];
      parts: PartReport[];
      usage: Usage;
    };

export interface DigestRunOptions {
  input: ContextInput;
  parts: ContextPart[];
  /** 작업 id의 앞부분. 부분 작업의 id는 `<jobPrefix>_part_001`이다 */
  jobPrefix: string;
  /** 추출 revision. 입력 해시에 들어간다 */
  extractionRevision: string;
  inflight: InflightStore;
  runner: LlmJobRunner;
  concurrency?: number;
  timeoutMs?: number;
  onEvent?: (event: LlmJobEvent) => void;
  /** 부분 하나가 끝날 때마다. 끝난 부분 수(앞선 실행의 것 포함)와 전체 부분 수 */
  onProgress?: (done: number, total: number) => void;
  log?: (line: string) => void;
}

const STOPPING: readonly LlmJobFailureKind[] = [
  'needs_login',
  'quota',
  'unavailable',
  'unsupported_policy',
];
const ZERO_USAGE: Usage = { logicalJobs: 0, turnCount: 0, elapsedMs: 0 };

export const partInputHash = (part: ContextPart, extractionRevision: string): string =>
  sha256Hex(
    stableStringify({
      promptVersion: promptVersionOf(CONTEXT_DIGEST_TEMPLATE),
      extractionRevision,
      sections: part.sections,
    }),
  );

export async function runDigests(options: DigestRunOptions): Promise<DigestRunResult> {
  const { input, parts, inflight, runner } = options;
  const log = options.log ?? (() => undefined);
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DIGEST_CONCURRENCY));
  const outline = input.body.map((s) => ({ title: s.title, parent: s.parent }));

  const done = new Map<number, { jobId: string; checked: ValidatedPart }>();
  const reports = new Map<number, PartReport>();
  const report = (part: ContextPart, over: Partial<PartReport>): PartReport => {
    const full: PartReport = {
      partId: part.id,
      jobId: null,
      sections: part.sections.length,
      sentences: part.sections.reduce((n, s) => n + s.sentenceIds.length, 0),
      estimatedTokens: part.estimatedTokens,
      outcome: 'not_sent',
      llmKind: null,
      problems: [],
      usage: null,
      ...over,
    };
    reports.set(part.index, full);
    return full;
  };
  const check = (part: ContextPart, text: string): ValidatedPart | null => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    if (!outputValidator(value)) return null;
    const checked = validatePartOutput(value, part, input);
    return checked.problems.length === 0 ? checked : null;
  };

  // 앞선 실행에서 끝난 부분을 찾는다. 남은 출력은 검증 전의 글이므로 다시 검증한다.
  const hashes = new Map(parts.map((p) => [p.id, partInputHash(p, options.extractionRevision)]));
  const partById = new Map(parts.map((p) => [p.id, p]));
  const stale: string[] = [];
  for (const entry of await inflight.list('context')) {
    if (!entry.meta.unitId.startsWith('part_')) continue;
    const part = partById.get(entry.meta.unitId);
    if (!part || hashes.get(part.id) !== entry.meta.inputHash) {
      stale.push(entry.meta.jobId);
      continue;
    }
    if (entry.meta.outcome !== 'ok' || done.has(part.index)) continue;
    const checked = check(part, entry.text);
    if (!checked) continue;
    done.set(part.index, { jobId: entry.meta.jobId, checked });
    report(part, { jobId: entry.meta.jobId, outcome: 'reused' });
    log(`context 부분 ${part.id}는 남은 출력 ${entry.meta.jobId}를 씀`);
  }
  if (stale.length > 0) await inflight.remove(stale);
  if (done.size > 0) options.onProgress?.(done.size, parts.length);

  let usage = ZERO_USAGE;
  let settled = done.size;
  const progressed = (): void => {
    settled += 1;
    options.onProgress?.(settled, parts.length);
  };
  let halted = false;
  const failures: { part: ContextPart; report: PartReport; message: string }[] = [];
  const queue = parts.filter((p) => !done.has(p.index));
  const worker = async (): Promise<void> => {
    for (;;) {
      if (halted) return;
      const part = queue.shift();
      if (part === undefined) return;
      const jobId = `${options.jobPrefix}_${part.id}`;
      const rendered = renderPrompt(CONTEXT_DIGEST_TEMPLATE, {
        inputs: {
          PAPER_METADATA: input.metadata,
          PAPER_OUTLINE: {
            sections: outline,
            part: part.index + 1,
            parts: parts.length,
            partSections: part.body.map((s) => s.title),
          },
          PAPER_PART: part.body,
        },
      });
      log(
        `context ${jobId} 시작 sections=${part.sections.length} tokens≈${part.estimatedTokens} prompt=${rendered.promptVersion}`,
      );
      const recorder = await inflight.begin({
        jobId,
        stage: 'context',
        unitId: part.id,
        attempt: part.index + 1,
        inputHash: hashes.get(part.id) ?? '',
        targetIds: part.sections.map((s) => s.sectionId),
        neighborIds: [],
      });
      const result: LlmJobResult = await runner.run(
        {
          jobId,
          prompt: rendered.prompt,
          instructions: rendered.instructions,
          outputSchema: DIGEST_OUTPUT_SCHEMA,
          research: { kind: 'none' },
          timeoutMs: options.timeoutMs ?? DIGEST_TIMEOUT_MS,
        },
        (event) => {
          recorder?.onEvent(event);
          options.onEvent?.(event);
        },
      );
      await recorder?.finish(result);
      usage = addUsage(usage, result.usage);
      if (!result.ok) {
        if (STOPPING.includes(result.kind)) halted = true;
        const made = report(part, {
          jobId,
          outcome: 'llm_failed',
          llmKind: result.kind,
          usage: result.usage,
        });
        failures.push({ part, report: made, message: result.message });
        log(`context ${jobId} 실패 kind=${result.kind} ${result.message}`);
        progressed();
        continue;
      }
      if (!outputValidator(result.value)) {
        const message = `부분 ${part.id}의 출력이 스키마와 맞지 않습니다: ${formatAjvErrors(outputValidator.errors).join('; ')}`;
        const made = report(part, { jobId, outcome: 'output_shape', usage: result.usage });
        failures.push({ part, report: made, message });
        progressed();
        continue;
      }
      const checked = validatePartOutput(result.value, part, input);
      if (checked.problems.length > 0) {
        const message = `부분 ${part.id} 검증 실패 ${checked.problems.length}건: ${checked.problems
          .slice(0, 5)
          .map((p) => p.message)
          .join('; ')}`;
        const made = report(part, {
          jobId,
          outcome: 'validation_failed',
          problems: checked.problems,
          usage: result.usage,
        });
        failures.push({ part, report: made, message });
        log(`context ${jobId} 검증 실패 ${checked.problems.map((p) => p.code).join(',')}`);
        progressed();
        continue;
      }
      done.set(part.index, { jobId, checked });
      report(part, { jobId, outcome: 'ok', usage: result.usage });
      progressed();
      log(
        `context ${jobId} 완료 digests=${checked.digests.length} notes=${checked.notes.length} in=${String(result.usage.inputTokens)} out=${String(result.usage.outputTokens)} elapsed=${result.usage.elapsedMs}ms`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

  for (const part of parts) if (!reports.has(part.index)) report(part, {});
  const ordered = parts.map((p) => reports.get(p.index)).filter((r) => r !== undefined);

  if (done.size < parts.length) {
    // 멈추게 한 실패(로그인·한도)를 먼저 알린다. 없으면 앞의 부분부터.
    const sorted = [...failures].sort((a, b) => a.part.index - b.part.index);
    const first =
      sorted.find((f) => f.report.llmKind !== null && STOPPING.includes(f.report.llmKind)) ??
      sorted[0];
    const outcome = first?.report.outcome;
    return {
      ok: false,
      code: outcome === 'output_shape' || outcome === 'validation_failed' ? outcome : 'llm_failed',
      message: first?.message ?? '부분 작업이 끝나지 않았습니다',
      llmKind: first?.report.llmKind ?? null,
      problems: first?.report.problems ?? [],
      parts: ordered,
      usage,
    };
  }

  const digests: SectionDigest[] = [];
  const coverage: Coverage[] = [];
  const notes: string[] = [];
  for (const part of parts) {
    const found = done.get(part.index);
    if (!found) continue;
    digests.push(...found.checked.digests);
    coverage.push(...found.checked.coverage.map((c) => ({ ...c, jobId: found.jobId })));
    notes.push(...found.checked.notes);
  }
  return { ok: true, digests, coverage, notes, parts: ordered, usage };
}
