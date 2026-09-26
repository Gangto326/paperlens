import { promises as fs } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sha256Hex } from './hash';

/**
 * 같은 디렉터리의 임시 파일에 쓰고 fsync한 뒤 rename으로 교체한다.
 * 실패하면 기존 파일은 그대로 남고 임시 파일은 정리한다.
 * 반환값은 기록한 바이트의 sha256.
 */
export async function writeFileAtomic(path: string, content: string | Buffer): Promise<string> {
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const buffer: Buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmp, 'w');
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tmp, path);
    await fsyncDir(dir);
    return sha256Hex(buffer);
  } catch (err) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function fsyncDir(dir: string): Promise<void> {
  try {
    const h = await fs.open(dir, 'r');
    try {
      await h.sync();
    } finally {
      await h.close();
    }
  } catch {
    // 일부 파일시스템은 디렉터리 fsync를 지원하지 않는다. rename 자체는 이미 완료됐다.
  }
}

/** 남아 있는 임시 파일(.name.pid.rand.tmp)을 정리한다. 재시작 복구 때 호출한다. */
export async function cleanupTempFiles(dir: string): Promise<string[]> {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return removed;
  }
  for (const name of entries) {
    if (name.startsWith('.') && name.endsWith('.tmp')) {
      await fs.rm(join(dir, name), { force: true });
      removed.push(name);
    }
  }
  return removed;
}
