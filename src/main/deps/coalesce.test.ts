import { describe, expect, it } from 'vitest';
import { coalesce } from './coalesce';

/** 손으로 끝내는 실행. 몇 번 시작됐는지 센다. */
function manual() {
  let runs = 0;
  const pending: { resolve: (v: number) => void; reject: (e: Error) => void }[] = [];
  const run = (): Promise<number> => {
    runs += 1;
    return new Promise<number>((resolve, reject) => pending.push({ resolve, reject }));
  };
  return { run, pending, runs: () => runs };
}

describe('coalesce', () => {
  it('돌고 있는 동안 몰린 호출은 실행 하나의 결과를 함께 받는다', async () => {
    const m = manual();
    const call = coalesce(m.run, { reuseMs: 0 });
    const calls = Array.from({ length: 500 }, () => call());
    expect(m.runs()).toBe(1);
    m.pending[0]!.resolve(7);
    expect(await Promise.all(calls)).toEqual(Array.from({ length: 500 }, () => 7));
    expect(m.runs()).toBe(1);
  });

  it('끝난 직후의 호출은 방금 결과를 받고, 시간이 지나면 새로 실행한다', async () => {
    const m = manual();
    let clock = 1_000;
    const call = coalesce(m.run, { reuseMs: 2_000, now: () => clock });
    const first = call();
    m.pending[0]!.resolve(1);
    expect(await first).toBe(1);

    clock += 1_999;
    expect(await call()).toBe(1);
    expect(m.runs()).toBe(1);

    clock += 1;
    const second = call();
    expect(m.runs()).toBe(2);
    m.pending[1]!.resolve(2);
    expect(await second).toBe(2);
  });

  it('결과를 받자마자 다시 부르는 순환이 생겨도 실행 수는 지난 시간에 묶인다', async () => {
    let runs = 0;
    let clock = 0;
    const call = coalesce(
      () => {
        runs += 1;
        return Promise.resolve(runs);
      },
      { reuseMs: 2_000, now: () => clock },
    );
    // 10초 동안 10ms마다 부른다(1,000번).
    for (let i = 0; i < 1_000; i += 1) {
      await call();
      clock += 10;
    }
    expect(runs).toBe(5);
  });

  it('실패는 함께 받되 다시 쓰지 않는다', async () => {
    const m = manual();
    const call = coalesce(m.run, { reuseMs: 2_000, now: () => 0 });
    const a = call();
    const b = call();
    m.pending[0]!.reject(new Error('docker 없음'));
    await expect(a).rejects.toThrow('docker 없음');
    await expect(b).rejects.toThrow('docker 없음');

    const c = call();
    expect(m.runs()).toBe(2);
    m.pending[1]!.resolve(3);
    expect(await c).toBe(3);
  });
});
