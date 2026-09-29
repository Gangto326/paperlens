import type {
  LlmCancelResult,
  LlmJobEvent,
  LlmJobFailureKind,
  LlmJobRequest,
  LlmJobResult,
  LlmJobRunner,
  LlmJobStage,
} from '../job';
import {
  runStructuredTurn,
  toUsage,
  type StructuredTurnResult,
  type TurnFailureKind,
  type TurnProgress,
  type TurnTransport,
} from './codex-turn';

/**
 * 구조화 작업 실행 어댑터(COMMIT_PLAN C2.1). 작업 ID 하나에 새 스레드 하나와 턴 하나를 쓴다.
 * 스레드를 재사용하지 않으므로 `thread/tokenUsage/updated`의 `total`이 그대로 그 작업의 사용량이다.
 * 스레드·턴 id와 프로토콜 알림은 이 파일 밖으로 나가지 않는다. 밖에서는 `../job`의 타입만 본다.
 * 동시 실행 수는 제한하지 않는다. 논문 단위 순차 실행은 스케줄러(C2.8) 몫이다.
 */
export interface CodexJobRunnerDeps {
  transport: () => TurnTransport | null;
  /** 도구 없는 새 스레드를 연다. `CodexRuntime.startThread`를 감싼다. */
  startThread: (options: {
    developerInstructions?: string;
  }) => Promise<{ threadId: string; model: string }>;
  /**
   * 조사 전용 런타임(PLAN 3.3.1). 내장 검색이 켜진 별도 프로세스다.
   * 없으면 조사 작업은 `unsupported_policy`로 거절한다. 도구 없는 런타임으로 바꿔 돌리지 않는다.
   */
  research?: {
    transport: () => TurnTransport | null;
    startThread: (options: {
      developerInstructions?: string;
    }) => Promise<{ threadId: string; model: string }>;
  };
  log?: (line: string) => void;
  /** 중단 요청 뒤 턴 종료를 기다리는 시간. 테스트에서 줄인다. */
  interruptGraceMs?: number;
}

interface ActiveJob {
  controller: AbortController;
  settled: Promise<LlmJobResult>;
}

/** 끝난 작업의 결과 종류를 기억하는 개수. 늦게 온 중단 요청에 already_finished로 답하기 위한 것이다. */
const FINISHED_MEMORY = 200;

const FAILURE_KIND: Record<TurnFailureKind, LlmJobFailureKind> = {
  unavailable: 'unavailable',
  needs_login: 'needs_login',
  quota: 'quota',
  turn_failed: 'failed',
  interrupted: 'interrupted',
  cancelled: 'cancelled',
  no_output: 'no_output',
  invalid_json: 'invalid_json',
  schema_mismatch: 'schema_mismatch',
  invalid_schema: 'invalid_schema',
  timeout: 'timeout',
  transport: 'transport',
  forbidden_tool: 'forbidden_tool',
};

/** 런타임의 항목 종류·단계 → 앱의 단계 이름. 모르는 값은 other. */
export function stageOf(itemType: string, phase: string | null): LlmJobStage | null {
  if (itemType === 'userMessage') return null;
  if (itemType === 'reasoning') return 'thinking';
  if (itemType === 'agentMessage') {
    if (phase === 'commentary') return 'commentary';
    return 'answer';
  }
  return 'other';
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class CodexJobRunner implements LlmJobRunner {
  private readonly active = new Map<string, ActiveJob>();
  private readonly finished = new Map<string, 'ok' | LlmJobFailureKind>();
  private readonly confirmed = new Map<string, boolean>();
  private readonly log: (line: string) => void;

  constructor(private readonly deps: CodexJobRunnerDeps) {
    this.log = deps.log ?? (() => undefined);
  }

  activeJobIds(): string[] {
    return [...this.active.keys()];
  }

  run(request: LlmJobRequest, onEvent?: (event: LlmJobEvent) => void): Promise<LlmJobResult> {
    const { jobId } = request;
    const t0 = Date.now();
    const emit = (event: LlmJobEvent): void => {
      if (!onEvent) return;
      try {
        onEvent(event);
      } catch (err) {
        this.log(`job ${jobId} onEvent 예외: ${messageOf(err)}`);
      }
    };
    const reject = (kind: LlmJobFailureKind, message: string): Promise<LlmJobResult> => {
      emit({ type: 'finished', jobId, outcome: kind, elapsedMs: Date.now() - t0 });
      return Promise.resolve({
        ok: false,
        jobId,
        kind,
        message,
        errors: [],
        rawText: null,
        model: null,
        usage: toUsage(null, Date.now() - t0, 0),
      });
    };

    // 실행 중인 작업의 기록을 건드리지 않도록 등록 전에 돌려준다.
    if (this.active.has(jobId)) {
      return reject('duplicate_job', `작업 ${jobId}가 이미 실행 중입니다`);
    }
    // 타입에 없는 정책이 런타임에 들어와도 도구 없는 턴으로 조용히 바꿔 돌리지 않는다.
    const policy = (request.research as { kind: string }).kind;
    if (policy !== 'none' && policy !== 'builtin_web') {
      return reject('unsupported_policy', `이 어댑터가 모르는 조사 정책입니다: ${policy}`);
    }
    if (policy === 'builtin_web' && !this.deps.research) {
      return reject('unsupported_policy', '조사 전용 런타임이 연결돼 있지 않습니다');
    }

    const controller = new AbortController();
    const settled = this.execute(request, controller.signal, emit, t0).then((result) => {
      this.active.delete(jobId);
      this.remember(jobId, result.ok ? 'ok' : result.kind);
      emit({
        type: 'finished',
        jobId,
        outcome: result.ok ? 'ok' : result.kind,
        elapsedMs: Date.now() - t0,
      });
      return result;
    });
    this.active.set(jobId, { controller, settled });
    return settled;
  }

  async cancel(jobId: string): Promise<LlmCancelResult> {
    const job = this.active.get(jobId);
    if (!job) {
      const outcome = this.finished.get(jobId);
      if (outcome === undefined) return { jobId, status: 'not_found' };
      return { jobId, status: 'already_finished', outcome };
    }
    job.controller.abort();
    const result = await job.settled;
    if (!result.ok && result.kind === 'cancelled') {
      return { jobId, status: 'cancelled', confirmed: this.confirmed.get(jobId) ?? false };
    }
    return { jobId, status: 'already_finished', outcome: result.ok ? 'ok' : result.kind };
  }

  private remember(jobId: string, outcome: 'ok' | LlmJobFailureKind): void {
    this.finished.delete(jobId);
    this.finished.set(jobId, outcome);
    while (this.finished.size > FINISHED_MEMORY) {
      const oldest = this.finished.keys().next().value;
      if (oldest === undefined) break;
      this.finished.delete(oldest);
      this.confirmed.delete(oldest);
    }
  }

  private async execute(
    request: LlmJobRequest,
    signal: AbortSignal,
    emit: (event: LlmJobEvent) => void,
    t0: number,
  ): Promise<LlmJobResult> {
    const { jobId } = request;
    let model: string | null = null;
    const failure = (kind: LlmJobFailureKind, message: string): LlmJobResult => ({
      ok: false,
      jobId,
      kind,
      message,
      errors: [],
      rawText: null,
      model,
      usage: toUsage(null, Date.now() - t0, 0),
    });

    const researching = request.research.kind === 'builtin_web';
    const runtime = researching && this.deps.research ? this.deps.research : this.deps;
    const transport = runtime.transport();
    if (!transport || transport.state !== 'running') {
      return failure(
        'unavailable',
        researching
          ? '조사 전용 LLM 런타임이 실행 중이 아닙니다'
          : 'LLM 런타임이 실행 중이 아닙니다',
      );
    }
    let threadId: string;
    try {
      const thread = await runtime.startThread(
        request.instructions !== undefined ? { developerInstructions: request.instructions } : {},
      );
      threadId = thread.threadId;
      model = thread.model;
    } catch (err) {
      return failure('transport', `작업을 시작할 수 없습니다: ${messageOf(err)}`);
    }
    if (signal.aborted) {
      this.confirmed.set(jobId, true);
      return failure('cancelled', '시작하기 전에 취소됐습니다');
    }

    const onProgress = (event: TurnProgress): void => {
      switch (event.type) {
        case 'started':
          emit({ type: 'started', jobId, model });
          break;
        case 'item': {
          const stage = stageOf(event.itemType, event.phase);
          if (stage) emit({ type: 'stage', jobId, stage, state: event.state });
          break;
        }
        case 'output':
          emit({
            type: 'output',
            jobId,
            chars: event.chars,
            item: event.item,
            delta: event.delta,
          });
          break;
        case 'usage':
          emit({ type: 'usage', jobId, usage: event.usage });
          break;
        case 'interrupt_requested':
          emit({ type: 'cancel_requested', jobId });
          break;
      }
    };

    const turn: StructuredTurnResult = await runStructuredTurn(
      transport,
      {
        threadId,
        prompt: request.prompt,
        outputSchema: request.outputSchema,
        research: researching,
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
      },
      {
        log: (line) => this.log(`job ${jobId} ${line}`),
        onProgress,
        signal,
        ...(this.deps.interruptGraceMs !== undefined
          ? { interruptGraceMs: this.deps.interruptGraceMs }
          : {}),
      },
    );
    const usage = { ...turn.usage, elapsedMs: Date.now() - t0 };
    if (turn.ok) {
      return {
        ok: true,
        jobId,
        value: turn.value,
        rawText: turn.rawText,
        model,
        usage,
        ...(turn.research ? { research: turn.research } : {}),
      };
    }
    if (turn.kind === 'cancelled') this.confirmed.set(jobId, turn.interruptConfirmed ?? false);
    return {
      ok: false,
      jobId,
      kind: FAILURE_KIND[turn.kind],
      message: turn.message,
      errors: turn.errors,
      rawText: turn.rawText,
      partialText: turn.partialText,
      model,
      usage,
      ...(turn.research ? { research: turn.research } : {}),
    };
  }
}
