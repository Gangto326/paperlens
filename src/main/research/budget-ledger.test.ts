import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BudgetDocument } from '@shared/schema';
import { PaperCacheStore } from '../cache/paper-cache-store';
import {
  BudgetLedger,
  BudgetLedgerError,
  budgetFilePersistence,
  INITIAL_BUDGET_LIMITS,
  type BudgetPersistence,
  type BudgetScopeSpec,
} from './budget-ledger';

const SHA = '7'.repeat(64);
const GEN = 'gen_test';
const NOW = new Date('2026-09-28T00:00:00.000Z');

const CHUNK: BudgetScopeSpec = {
  scopeId: `${GEN}:pass2:chunk_0001`,
  scopeType: 'pass2_chunk',
  limits: { searchRequests: 1, fetchRequests: 2, toolCalls: 6 },
};
const PAPER: BudgetScopeSpec = {
  scopeId: `${GEN}:pass2`,
  scopeType: 'pass2_paper',
  limits: { searchRequests: 6, fetchRequests: 12, toolCalls: 36 },
};
const PASS1: BudgetScopeSpec = {
  scopeId: `${GEN}:pass1`,
  scopeType: 'pass1',
  limits: { searchRequests: 3, fetchRequests: 4, toolCalls: 5 },
};

let root: string;
let store: PaperCacheStore;
let persistence: BudgetPersistence;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'paperlens-budget-'));
  store = new PaperCacheStore(root);
  persistence = budgetFilePersistence(store, SHA, GEN);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const open = async (
  p: BudgetPersistence = persistence,
): Promise<Awaited<ReturnType<typeof BudgetLedger.open>>> =>
  BudgetLedger.open({ generationId: GEN, persistence: p, now: () => NOW });

const search = (
  ledger: BudgetLedger,
  scopeIds: string[],
  query = 'dense retrieval',
): ReturnType<BudgetLedger['reserve']> =>
  ledger.reserve({ scopeIds, jobId: 'job_1', kind: 'search', queryOrUrl: query });

const onDisk = async (): Promise<BudgetDocument> =>
  store.readJson('budgetDocument', store.generationPath(SHA, GEN, 'budget.json'));

describe('BudgetLedger', () => {
  it('상한 N까지 예약하고 N+1번째는 외부로 보내기 전에 거절한다', async () => {
    const { ledger } = await open();
    await ledger.ensureScopes([PASS1]);
    for (let i = 0; i < 3; i += 1) {
      expect((await search(ledger, [PASS1.scopeId], `q${i}`)).ok).toBe(true);
    }
    const refused = await search(ledger, [PASS1.scopeId], 'q3');
    expect(refused).toMatchObject({ ok: false, code: 'budget_exhausted', scopeId: PASS1.scopeId });
    expect(ledger.remaining(PASS1.scopeId)).toEqual({
      searchRequests: 0,
      fetchRequests: 4,
      toolCalls: 5,
    });
    // 거절된 요청은 장부에 예약으로 남지 않는다.
    expect((await onDisk()).budgets[0]?.reservations).toHaveLength(3);
  });

  it('예약은 돌아오기 전에 디스크에 확정된다. 질의 원문은 저장하지 않는다', async () => {
    const { ledger } = await open();
    await ledger.ensureScopes([PASS1]);
    const result = await search(ledger, [PASS1.scopeId], '비밀 질의');
    if (!result.ok) throw new Error('예약 실패');
    const saved = await onDisk();
    expect(saved.budgets[0]?.used.searchRequests).toBe(1);
    expect(saved.budgets[0]?.reservations[0]).toMatchObject({
      id: result.reservation.id,
      jobId: 'job_1',
      kind: 'search',
      state: 'reserved',
    });
    expect(result.reservation.queryOrUrlHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(saved)).not.toContain('비밀 질의');
  });

  it('동시에 들어온 요청도 상한을 넘지 못한다', async () => {
    const { ledger } = await open();
    await ledger.ensureScopes([PASS1]);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => search(ledger, [PASS1.scopeId], `q${i}`)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok)).toHaveLength(7);
    const saved = await onDisk();
    expect(saved.budgets[0]?.used.searchRequests).toBe(3);
    expect(new Set(saved.budgets[0]?.reservations.map((r) => r.id)).size).toBe(3);
  });

  it('범위를 동시에 적용한다. 큰 범위가 소진되면 작은 범위에 여유가 있어도 거절한다', async () => {
    const { ledger } = await open();
    const tight = { ...PAPER, limits: { ...PAPER.limits, searchRequests: 1 } };
    const other = { ...CHUNK, scopeId: `${GEN}:pass2:chunk_0002` };
    await ledger.ensureScopes([CHUNK, other, tight]);
    expect((await search(ledger, [CHUNK.scopeId, tight.scopeId])).ok).toBe(true);
    const refused = await search(ledger, [other.scopeId, tight.scopeId]);
    expect(refused).toMatchObject({ ok: false, code: 'budget_exhausted', scopeId: tight.scopeId });
    // 거절된 요청은 어느 범위의 사용량도 늘리지 않는다.
    expect(ledger.remaining(other.scopeId)?.searchRequests).toBe(1);
    expect(ledger.remaining(tight.scopeId)?.searchRequests).toBe(0);
    // 작은 범위가 소진된 경우도 같다.
    const again = await search(ledger, [CHUNK.scopeId, tight.scopeId]);
    expect(again).toMatchObject({ ok: false, scopeId: CHUNK.scopeId });
  });

  it('실패한 요청과 재시도도 횟수에 든다', async () => {
    const { ledger } = await open();
    await ledger.ensureScopes([CHUNK]);
    const first = await ledger.reserve({
      scopeIds: [CHUNK.scopeId],
      jobId: 'job_1',
      kind: 'fetch',
      queryOrUrl: 'https://example.org/a',
    });
    if (!first.ok) throw new Error('예약 실패');
    await ledger.markSent(first.reservation.id);
    await ledger.complete(first.reservation.id, { state: 'failed' });
    const retry = await ledger.reserve({
      scopeIds: [CHUNK.scopeId],
      jobId: 'job_1',
      kind: 'fetch',
      queryOrUrl: 'https://example.org/a',
      parentRequestId: first.reservation.id,
    });
    expect(retry.ok).toBe(true);
    const third = await ledger.reserve({
      scopeIds: [CHUNK.scopeId],
      jobId: 'job_1',
      kind: 'fetch',
      queryOrUrl: 'https://example.org/a',
    });
    expect(third).toMatchObject({ ok: false, code: 'budget_exhausted' });
    const saved = await onDisk();
    expect(saved.budgets[0]?.reservations.map((r) => [r.state, r.parentRequestId])).toEqual([
      ['failed', null],
      ['reserved', first.reservation.id],
    ]);
  });

  it('다시 열어도 사용량이 남고, 끝을 모르는 예약은 unknown이 되며 소비로 친다', async () => {
    const first = await open();
    await first.ledger.ensureScopes([PASS1]);
    const a = await search(first.ledger, [PASS1.scopeId], 'a');
    const b = await search(first.ledger, [PASS1.scopeId], 'b');
    const c = await search(first.ledger, [PASS1.scopeId], 'c');
    if (!a.ok || !b.ok || !c.ok) throw new Error('예약 실패');
    await first.ledger.markSent(a.reservation.id);
    await first.ledger.complete(a.reservation.id, {
      state: 'succeeded',
      responseSourceId: 'src_1',
    });
    await first.ledger.markSent(b.reservation.id);
    // 여기서 앱이 꺼졌다. b는 보냈는지 모르고 c는 보내기 전이다.

    const second = await open();
    expect(second.recovered.map((r) => r.id).sort()).toEqual(
      [b.reservation.id, c.reservation.id].sort(),
    );
    // 같은 범위를 다시 만들어도 예산은 다시 채워지지 않는다.
    await second.ledger.ensureScopes([PASS1]);
    expect(second.ledger.remaining(PASS1.scopeId)?.searchRequests).toBe(0);
    expect((await search(second.ledger, [PASS1.scopeId], 'd')).ok).toBe(false);
    const saved = await onDisk();
    expect(saved.budgets[0]?.reservations.map((r) => r.state)).toEqual([
      'succeeded',
      'unknown',
      'unknown',
    ]);
    // 뒤늦게 온 결과가 unknown을 덮어쓰지 않는다.
    await second.ledger.complete(b.reservation.id, { state: 'succeeded' });
    expect((await onDisk()).budgets[0]?.reservations[1]?.state).toBe('unknown');
  });

  it('캐시 적중은 외부 요청 예산을 쓰지 않고 도구 호출 수에만 든다', async () => {
    const { ledger } = await open();
    await ledger.ensureScopes([PASS1]);
    for (let i = 0; i < 5; i += 1) {
      expect(await ledger.countToolCall([PASS1.scopeId])).toEqual({ ok: true });
    }
    expect(await ledger.countToolCall([PASS1.scopeId])).toMatchObject({
      ok: false,
      code: 'tool_calls_exhausted',
    });
    expect(ledger.remaining(PASS1.scopeId)).toEqual({
      searchRequests: 3,
      fetchRequests: 4,
      toolCalls: 0,
    });
  });

  it('없는 범위와 없는 예약은 거절한다', async () => {
    const { ledger } = await open();
    expect(await search(ledger, ['nope'])).toMatchObject({ ok: false, code: 'unknown_scope' });
    expect(await search(ledger, [])).toMatchObject({ ok: false, code: 'unknown_scope' });
    await expect(ledger.markSent('rq_none')).rejects.toBeInstanceOf(BudgetLedgerError);
  });

  it('저장에 실패하면 예약은 없던 일이 되고 다음 요청은 정상으로 돈다', async () => {
    let fail = false;
    const flaky: BudgetPersistence = {
      load: () => persistence.load(),
      save: (document) =>
        fail ? Promise.reject(new Error('disk full')) : persistence.save(document),
    };
    const { ledger } = await open(flaky);
    await ledger.ensureScopes([PASS1]);
    fail = true;
    await expect(search(ledger, [PASS1.scopeId])).rejects.toThrow('disk full');
    expect(ledger.remaining(PASS1.scopeId)?.searchRequests).toBe(3);
    fail = false;
    expect((await search(ledger, [PASS1.scopeId])).ok).toBe(true);
    expect(ledger.remaining(PASS1.scopeId)?.searchRequests).toBe(2);
  });

  it('읽을 수 없는 장부와 다른 세대의 장부는 새로 만들지 않고 멈춘다', async () => {
    const path = store.generationPath(SHA, GEN, 'budget.json');
    await fs.mkdir(join(path, '..'), { recursive: true });
    await fs.writeFile(path, '{ 깨진 파일');
    await expect(open()).rejects.toMatchObject({ code: 'unreadable' });

    const { ledger } = await BudgetLedger.open({
      generationId: 'gen_other',
      persistence: budgetFilePersistence(store, SHA, 'gen_other'),
      now: () => NOW,
    });
    await ledger.ensureScopes([PASS1]);
    await fs.copyFile(store.generationPath(SHA, 'gen_other', 'budget.json'), path);
    await expect(open()).rejects.toMatchObject({ code: 'generation_mismatch' });
  });

  it('초기 예산은 PLAN 3.3의 표와 같다', () => {
    expect(INITIAL_BUDGET_LIMITS).toEqual({
      pass1: { searchRequests: 8, fetchRequests: 16, toolCalls: 32 },
      pass1Long: { searchRequests: 12, fetchRequests: 24, toolCalls: 48 },
      pass2Chunk: { searchRequests: 1, fetchRequests: 2, toolCalls: 6 },
      pass2Paper: { searchRequests: 6, fetchRequests: 12, toolCalls: 36 },
    });
  });
});
