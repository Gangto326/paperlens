import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import type { Failure, PaperState } from '@shared/schema';
import { sha256Hex, stableStringify } from '../cache/hash';
import { CacheReadError, type PaperCacheStore } from '../cache/paper-cache-store';

/**
 * 재시작 복구(PLAN 8.3, COMMIT_PLAN C3.3). 처리를 시작하기 전에 논문 캐시를 점검한다.
 * 앱이 처리 도중에 죽었어도 확정된 결과는 그대로 쓰고, 어긋난 것만 다시 하게 만든다.
 *
 * 1. 남은 임시 파일을 지운다.
 * 2. manifest에 적힌 세대 파일의 해시를 대조한다. 없거나 해시가 다른 파일은 기록에서 빼고 지운다.
 *    그 파일이 맡던 작업(청크, 조사, 컨텍스트)은 다음 실행이 다시 한다.
 * 3. 디스크에는 있는데 manifest에 없는 청크 파일을 본다. 결과 파일을 쓴 뒤 manifest를 고치기 전에 죽은 경우다.
 *    스키마가 맞고 완료 상태이고 결과의 해시가 맞으면 manifest에 적는다. 입력이 지금과 같은지는 청크 실행이 본다.
 *    아니면 지운다.
 * 4. 상태를 다시 시작할 수 있는 상태로 돌린다. 조사 도중(`researching`)에 죽었으면 `context_pending`이다.
 *
 * 추출 단계의 파일(extraction/)은 건드리지 않는다. 논문을 열 때 추출이 다시 확인한다.
 * 돌던 작업의 출력(inflight/)도 건드리지 않는다. 청크 실행과 조사 패스가 검증해서 쓴다.
 */
export const RECOVERY_STAGE = 'recovery';

export interface RecoveryReport {
  removedTemp: string[];
  /** manifest에서 빼고 지운 파일 */
  dropped: { path: string; problem: 'missing' | 'hash_mismatch' }[];
  /** manifest에 없었지만 온전해서 적은 청크 파일 */
  adopted: string[];
  /** manifest에 없고 쓸 수 없어 지운 청크 파일 */
  discarded: string[];
  stateBefore: PaperState;
  stateAfter: PaperState;
}

const compact = (d: Date): string =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

export const changed = (report: RecoveryReport): boolean =>
  report.dropped.length > 0 ||
  report.adopted.length > 0 ||
  report.discarded.length > 0 ||
  report.stateBefore !== report.stateAfter;

export async function recoverPaper(
  store: PaperCacheStore,
  pdfSha256: string,
  options: { now?: () => Date; log?: (line: string) => void } = {},
): Promise<RecoveryReport> {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => undefined);
  const paperDir = store.paperDir(pdfSha256);
  const removedTemp = await store.cleanupTemp(pdfSha256);

  const dropped = (await store.verifyFiles(pdfSha256)).filter((p) =>
    p.path.startsWith(`generations${'/'}`),
  );
  for (const file of dropped) await fs.rm(join(paperDir, file.path), { force: true });

  const manifest = await store.readManifest(pdfSha256);
  const recorded = new Set(manifest.files.map((f) => f.path));
  const adopted: { path: string; sha256: string }[] = [];
  const discarded: string[] = [];
  const generationsDir = join(paperDir, 'generations');
  for (const generation of await fs.readdir(generationsDir).catch(() => [] as string[])) {
    const chunksDir = join(generationsDir, generation, 'chunks');
    for (const name of await fs.readdir(chunksDir).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) continue;
      const absolute = join(chunksDir, name);
      const path = relative(paperDir, absolute);
      if (recorded.has(path)) continue;
      try {
        const doc = await store.readJson('chunkDocument', absolute);
        const sound =
          doc.status === 'complete' &&
          doc.resultHash === sha256Hex(stableStringify(doc.results)) &&
          doc.results.length === doc.targetSentenceIds.length;
        if (!sound) throw new CacheReadError(absolute, 'schema', ['완료된 청크가 아닙니다']);
        adopted.push({ path, sha256: sha256Hex(await fs.readFile(absolute)) });
      } catch (err) {
        if (!(err instanceof CacheReadError)) throw err;
        await fs.rm(absolute, { force: true });
        discarded.push(path);
      }
    }
  }

  const stateBefore = manifest.state;
  const stateAfter: PaperState = stateBefore === 'researching' ? 'context_pending' : stateBefore;
  const report: RecoveryReport = {
    removedTemp,
    dropped,
    adopted: adopted.map((a) => a.path),
    discarded,
    stateBefore,
    stateAfter,
  };
  if (!changed(report)) return report;

  const at = now();
  await store.updateManifest(
    pdfSha256,
    (m) => {
      const gone = new Set(dropped.map((d) => d.path));
      m.files = m.files.filter((f) => !gone.has(f.path));
      for (const file of adopted) {
        if (!m.files.some((f) => f.path === file.path)) m.files.push(file);
      }
      if (m.state === stateBefore) m.state = stateAfter;
      for (const file of dropped) {
        const failure: Failure = {
          id: `err_${compact(at)}_${m.errors.length + 1}`,
          stage: RECOVERY_STAGE,
          code: `file_${file.problem}`,
          message: `${file.path} 파일이 기록과 달라 다시 만듭니다`,
          retryable: true,
          attempt: 1,
          occurredAt: at.toISOString(),
          nextRetryAt: null,
        };
        m.errors.push(failure);
      }
    },
    at,
  );
  log(
    `recovery ${pdfSha256.slice(0, 8)} temp=${removedTemp.length} dropped=${dropped.length} adopted=${adopted.length} discarded=${discarded.length} state=${stateBefore}→${stateAfter}`,
  );
  return report;
}
