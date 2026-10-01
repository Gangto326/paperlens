/**
 * 겹쳐 들어온 호출을 한 번의 실행으로 묶는다(C5.1 점검의 보호 장치).
 *
 * 점검 한 번은 `docker` 명령을 여러 개 띄운다. 점검을 부르는 쪽이 잘못돼 호출이 쉬지 않고 몰리면
 * (2026-10-01: 점검 → 계정 이벤트 → 점검의 순환) 프로세스가 끝없이 쌓여 머신이 멈춘다.
 * 그래서 부르는 쪽이 어떻게 부르든 실행 수가 늘지 않게 한다.
 * - 돌고 있는 실행이 있으면 새로 띄우지 않고 그 결과를 함께 받는다.
 * - 끝난 직후(`reuseMs` 안)의 호출은 방금 결과를 받는다. 순환이 생겨도 실행은 `reuseMs`에 한 번을 넘지 않는다.
 * - 실패는 다시 쓰지 않는다. 다음 호출이 새로 실행한다.
 */
export function coalesce<T>(
  run: () => Promise<T>,
  opts: { reuseMs: number; now?: () => number },
): () => Promise<T> {
  const now = opts.now ?? Date.now;
  let inFlight: Promise<T> | null = null;
  let last: { value: T; at: number } | null = null;
  return () => {
    if (inFlight) return inFlight;
    if (last && now() - last.at < opts.reuseMs) return Promise.resolve(last.value);
    const started = run()
      .then((value) => {
        last = { value, at: now() };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    inFlight = started;
    return started;
  };
}
