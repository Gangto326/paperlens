import {
  SCHEMA_VERSION,
  type Budget,
  type BudgetCounters,
  type BudgetDocument,
  type RequestReservation,
} from '@shared/schema';
import { sha256Hex } from '../cache/hash';
import { CacheReadError, type PaperCacheStore } from '../cache/paper-cache-store';

/**
 * 조사 예산 장부(PLAN 3.3, COMMIT_PLAN C4.1). Electron 메인이 단독으로 소유한다(COMMIT_PLAN 0.3-2).
 *
 * - 외부 요청 직전에 `reserve`가 남은 예산을 검사하고 예약을 디스크에 확정한 뒤에야 돌아온다.
 *   호출자는 `reserve`가 성공한 뒤에만 외부로 요청을 보낸다.
 * - 예약하는 순간 소비로 센다. 실패한 요청과 재시도도 횟수에 든다. `used`는 줄어들지 않는다.
 * - 범위(청크·논문·패스)는 동시에 적용한다. 하나라도 소진됐으면 어느 범위에도 기록하지 않고 거절한다.
 * - 장부를 다시 열 때 끝을 모르는 예약(reserved·sent)은 `unknown`으로 바꾼다. 소비는 그대로 둔다.
 * - 캐시 적중은 외부 요청이 아니므로 `reserve`를 부르지 않는다. 도구 호출 수(`countToolCall`)에만 든다.
 * - 모든 변경은 한 줄로 세운다. 동시에 들어온 요청도 상한을 넘지 못한다.
 *
 * 계획과 다른 점: budget.json은 요청마다 바뀌므로 manifest.files에 해시를 기록하지 않는다.
 * 읽을 때는 스키마 검증만 한다. 읽을 수 없는 장부는 새로 만들지 않고 오류로 멈춘다.
 */
export type BudgetScopeType = Budget['scopeType'];

export interface BudgetScopeSpec {
  scopeId: string;
  scopeType: BudgetScopeType;
  limits: BudgetCounters;
}

export type BudgetKind = RequestReservation['kind'];

export type BudgetRefusalCode = 'budget_exhausted' | 'tool_calls_exhausted' | 'unknown_scope';

export interface BudgetRefusal {
  ok: false;
  code: BudgetRefusalCode;
  /** 막은 범위 */
  scopeId: string;
  message: string;
}

export type ReserveResult = { ok: true; reservation: RequestReservation } | BudgetRefusal;
export type ToolCallResult = { ok: true } | BudgetRefusal;

export interface BudgetPersistence {
  /** 저장된 장부. 파일이 없으면 null. 읽을 수 없으면 던진다. */
  load(): Promise<BudgetDocument | null>;
  save(document: BudgetDocument): Promise<void>;
}

export class BudgetLedgerError extends Error {
  constructor(
    readonly code: 'unreadable' | 'unknown_reservation' | 'generation_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'BudgetLedgerError';
  }
}

const COUNTER_OF: Record<BudgetKind, keyof BudgetCounters> = {
  search: 'searchRequests',
  fetch: 'fetchRequests',
};

const OPEN_STATES: ReadonlySet<RequestReservation['state']> = new Set(['reserved', 'sent']);

export const ZERO_COUNTERS: BudgetCounters = { searchRequests: 0, fetchRequests: 0, toolCalls: 0 };

/** PLAN 3.3의 초기 예산. 측정 뒤 조정할 제품 설정이다. */
export const INITIAL_BUDGET_LIMITS = {
  pass1: { searchRequests: 8, fetchRequests: 16, toolCalls: 32 },
  pass1Long: { searchRequests: 12, fetchRequests: 24, toolCalls: 48 },
  pass2Chunk: { searchRequests: 1, fetchRequests: 2, toolCalls: 6 },
  pass2Paper: { searchRequests: 6, fetchRequests: 12, toolCalls: 36 },
} as const satisfies Record<string, BudgetCounters>;

export class BudgetLedger {
  private queue: Promise<unknown> = Promise.resolve();
  private counter = 0;

  private constructor(
    private document: BudgetDocument,
    private readonly generationId: string,
    private readonly persistence: BudgetPersistence,
    private readonly now: () => Date,
  ) {}

  /** 장부를 연다. 끝을 모르는 예약이 있으면 `unknown`으로 바꿔 저장한다. */
  static async open(options: {
    generationId: string;
    persistence: BudgetPersistence;
    now?: () => Date;
  }): Promise<{ ledger: BudgetLedger; recovered: RequestReservation[] }> {
    const now = options.now ?? (() => new Date());
    const loaded = await options.persistence.load();
    const document: BudgetDocument = loaded ?? { schemaVersion: SCHEMA_VERSION, budgets: [] };
    const foreign = document.budgets.find((b) => b.generationId !== options.generationId);
    if (foreign) {
      throw new BudgetLedgerError(
        'generation_mismatch',
        `장부의 세대가 다릅니다: ${foreign.generationId} (기대 ${options.generationId})`,
      );
    }
    const recovered: RequestReservation[] = [];
    for (const budget of document.budgets) {
      let changed = false;
      for (const reservation of budget.reservations) {
        if (!OPEN_STATES.has(reservation.state)) continue;
        reservation.state = 'unknown';
        reservation.completedAt = now().toISOString();
        recovered.push({ ...reservation });
        changed = true;
      }
      if (changed) {
        budget.revision += 1;
        budget.updatedAt = now().toISOString();
      }
    }
    const ledger = new BudgetLedger(document, options.generationId, options.persistence, now);
    if (recovered.length > 0) await options.persistence.save(document);
    return { ledger, recovered };
  }

  /** 읽기용 사본. */
  snapshot(): BudgetDocument {
    return structuredClone(this.document);
  }

  remaining(scopeId: string): BudgetCounters | undefined {
    const budget = this.document.budgets.find((b) => b.scopeId === scopeId);
    if (!budget) return undefined;
    return {
      searchRequests: Math.max(0, budget.limits.searchRequests - budget.used.searchRequests),
      fetchRequests: Math.max(0, budget.limits.fetchRequests - budget.used.fetchRequests),
      toolCalls: Math.max(0, budget.limits.toolCalls - budget.used.toolCalls),
    };
  }

  /**
   * 범위를 만든다. 이미 있으면 그대로 둔다. 상한과 사용량을 다시 채우지 않는다
   * (재시작·재시도·대화 재생성으로 예산이 초기화되면 안 된다).
   */
  ensureScopes(specs: readonly BudgetScopeSpec[]): Promise<void> {
    return this.exclusive(async () => {
      const next = structuredClone(this.document);
      let changed = false;
      for (const spec of specs) {
        if (next.budgets.some((b) => b.scopeId === spec.scopeId)) continue;
        next.budgets.push({
          scopeId: spec.scopeId,
          scopeType: spec.scopeType,
          generationId: this.generationId,
          limits: { ...spec.limits },
          used: { ...ZERO_COUNTERS },
          reservations: [],
          revision: 0,
          updatedAt: this.now().toISOString(),
        });
        changed = true;
      }
      if (changed) await this.commit(next);
    });
  }

  /**
   * 외부 요청 1회를 예약한다. 돌아왔을 때는 디스크에 확정돼 있다.
   * `scopeIds`는 좁은 범위부터 적는다. 예약 기록은 첫 범위에 남고 사용량은 모든 범위에 더한다.
   */
  reserve(request: {
    scopeIds: readonly string[];
    jobId: string;
    kind: BudgetKind;
    queryOrUrl: string;
    parentRequestId?: string | null;
  }): Promise<ReserveResult> {
    return this.exclusive(async () => {
      const next = structuredClone(this.document);
      const scopes = this.scopesOf(next, request.scopeIds);
      if (!Array.isArray(scopes)) return scopes;
      const key = COUNTER_OF[request.kind];
      const full = scopes.find((b) => b.used[key] >= b.limits[key]);
      if (full) {
        return {
          ok: false,
          code: 'budget_exhausted',
          scopeId: full.scopeId,
          message: `${request.kind} 예산을 다 썼습니다: ${full.scopeId} ${full.used[key]}/${full.limits[key]}`,
        };
      }
      const at = this.now().toISOString();
      this.counter += 1;
      const reservation: RequestReservation = {
        id: `rq_${sha256Hex(`${request.jobId}|${at}|${this.counter}|${Math.random()}`).slice(0, 16)}`,
        jobId: request.jobId,
        parentRequestId: request.parentRequestId ?? null,
        kind: request.kind,
        queryOrUrlHash: sha256Hex(request.queryOrUrl),
        reservedAt: at,
        state: 'reserved',
        completedAt: null,
        responseSourceId: null,
      };
      scopes.forEach((budget, i) => {
        budget.used[key] += 1;
        if (i === 0) budget.reservations.push(reservation);
        budget.revision += 1;
        budget.updatedAt = at;
      });
      await this.commit(next);
      return { ok: true, reservation: { ...reservation } };
    });
  }

  /** 모델의 도구 호출 1회를 센다. 캐시 적중과 거절된 호출도 여기에 든다. */
  countToolCall(scopeIds: readonly string[]): Promise<ToolCallResult> {
    return this.exclusive(async () => {
      const next = structuredClone(this.document);
      const scopes = this.scopesOf(next, scopeIds);
      if (!Array.isArray(scopes)) return scopes;
      const full = scopes.find((b) => b.used.toolCalls >= b.limits.toolCalls);
      if (full) {
        return {
          ok: false,
          code: 'tool_calls_exhausted',
          scopeId: full.scopeId,
          message: `도구 호출 상한에 닿았습니다: ${full.scopeId} ${full.used.toolCalls}/${full.limits.toolCalls}`,
        };
      }
      const at = this.now().toISOString();
      for (const budget of scopes) {
        budget.used.toolCalls += 1;
        budget.revision += 1;
        budget.updatedAt = at;
      }
      await this.commit(next);
      return { ok: true };
    });
  }

  /** 요청을 외부로 보내기 직전에 부른다. */
  markSent(reservationId: string): Promise<void> {
    return this.transition(reservationId, (r) => {
      if (r.state === 'reserved') r.state = 'sent';
    });
  }

  /** 요청이 끝났다. 실패해도 소비는 되돌리지 않는다. */
  complete(
    reservationId: string,
    outcome: { state: 'succeeded' | 'failed'; responseSourceId?: string | null },
  ): Promise<void> {
    return this.transition(reservationId, (r, at) => {
      // 재시작으로 unknown이 된 예약은 뒤늦은 결과로 덮어쓰지 않는다.
      if (!OPEN_STATES.has(r.state)) return;
      r.state = outcome.state;
      r.completedAt = at;
      r.responseSourceId = outcome.responseSourceId ?? null;
    });
  }

  private transition(
    reservationId: string,
    apply: (reservation: RequestReservation, at: string) => void,
  ): Promise<void> {
    return this.exclusive(async () => {
      const next = structuredClone(this.document);
      for (const budget of next.budgets) {
        const found = budget.reservations.find((r) => r.id === reservationId);
        if (!found) continue;
        const at = this.now().toISOString();
        apply(found, at);
        budget.revision += 1;
        budget.updatedAt = at;
        await this.commit(next);
        return;
      }
      throw new BudgetLedgerError('unknown_reservation', `없는 예약입니다: ${reservationId}`);
    });
  }

  private scopesOf(
    document: BudgetDocument,
    scopeIds: readonly string[],
  ): Budget[] | BudgetRefusal {
    const ids = [...new Set(scopeIds)];
    const scopes: Budget[] = [];
    for (const scopeId of ids) {
      const budget = document.budgets.find((b) => b.scopeId === scopeId);
      if (!budget) {
        return {
          ok: false,
          code: 'unknown_scope',
          scopeId,
          message: `예산 범위가 없습니다: ${scopeId}`,
        };
      }
      scopes.push(budget);
    }
    if (scopes.length === 0) {
      return {
        ok: false,
        code: 'unknown_scope',
        scopeId: '',
        message: '예산 범위를 주지 않았습니다',
      };
    }
    return scopes;
  }

  /** 저장에 성공한 뒤에만 메모리의 장부를 바꾼다. 저장에 실패하면 예약은 없던 일이 된다. */
  private async commit(next: BudgetDocument): Promise<void> {
    await this.persistence.save(next);
    this.document = next;
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/** 세대 폴더의 budget.json을 쓰는 저장 방식. */
export function budgetFilePersistence(
  store: PaperCacheStore,
  pdfSha256: string,
  generationId: string,
): BudgetPersistence {
  const path = store.generationPath(pdfSha256, generationId, 'budget.json');
  return {
    async load() {
      try {
        return await store.readJson('budgetDocument', path);
      } catch (err) {
        if (err instanceof CacheReadError && err.reason === 'missing') return null;
        const detail = err instanceof Error ? err.message : String(err);
        throw new BudgetLedgerError('unreadable', `예산 장부를 읽을 수 없습니다: ${detail}`);
      }
    },
    async save(document) {
      await store.writeJson('budgetDocument', path, document);
    },
  };
}
