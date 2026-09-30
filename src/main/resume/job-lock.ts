import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PaperCacheStore } from '../cache/paper-cache-store';

/**
 * 논문 단위 작업 락(PLAN 8.3, COMMIT_PLAN C3.3). 같은 논문을 두 프로세스가 함께 처리하지 못하게 한다.
 * `papers/<sha>/job.lock`을 새로 만들 수 있을 때만 잡는다. 파일에는 잡은 프로세스의 pid와 시각을 적는다.
 * 락이 남아 있어도 그 프로세스가 살아 있지 않으면 앱이 죽으면서 남긴 것이다. 치우고 잡는다.
 * 같은 프로세스 안에서의 중복 실행은 스케줄러가 막는다. 자기 pid의 락이 남아 있으면 풀지 못한 락으로 본다.
 * pid는 운영체제가 다시 쓸 수 있다. 죽은 프로세스의 pid를 다른 프로그램이 받았으면 락을 치우지 못한다.
 * 그때는 그 논문을 처리하지 못하고 "처리 중"으로 남는다. 락 파일을 지우면 풀린다.
 */
export interface LockHolder {
  pid: number;
  startedAt: string;
}

export type LockResult =
  | { ok: true; release: () => Promise<void>; tookOver: LockHolder | null }
  | { ok: false; holder: LockHolder };

export const lockPath = (store: PaperCacheStore, pdfSha256: string): string =>
  join(store.paperDir(pdfSha256), 'job.lock');

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // 권한이 없어 신호를 보내지 못한 것이면 프로세스는 있다.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const readHolder = async (path: string): Promise<LockHolder | null> => {
  try {
    const value: unknown = JSON.parse(await fs.readFile(path, 'utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const { pid, startedAt } = value as Record<string, unknown>;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || typeof startedAt !== 'string') {
      return null;
    }
    return { pid, startedAt };
  } catch {
    return null;
  }
};

export async function acquireJobLock(
  store: PaperCacheStore,
  pdfSha256: string,
  options: { pid?: number; now?: () => Date } = {},
): Promise<LockResult> {
  const path = lockPath(store, pdfSha256);
  const pid = options.pid ?? process.pid;
  const body = `${JSON.stringify({ pid, startedAt: (options.now ?? (() => new Date()))().toISOString() })}\n`;
  await fs.mkdir(dirname(path), { recursive: true });
  let tookOver: LockHolder | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.writeFile(path, body, { flag: 'wx' });
      return {
        ok: true,
        tookOver,
        release: async () => {
          const holder = await readHolder(path);
          if (holder?.pid === pid) await fs.rm(path, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const holder = await readHolder(path);
    if (holder && holder.pid !== pid && alive(holder.pid)) return { ok: false, holder };
    // 읽을 수 없는 락, 죽은 프로세스의 락, 자기 pid의 락은 치운다.
    tookOver = holder;
    await fs.rm(path, { force: true });
  }
  const holder = await readHolder(path);
  return { ok: false, holder: holder ?? { pid: -1, startedAt: '' } };
}
