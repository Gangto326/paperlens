import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PaperCacheStore } from './paper-cache-store';
import { PaperDataDeletion } from './paper-data-deletion';

const sha = 'a'.repeat(64);
const other = 'b'.repeat(64);
let root: string;
let store: PaperCacheStore;
let deletion: PaperDataDeletion;
const busy = vi.fn(() => false);
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'paperlens-delete-'));
  store = new PaperCacheStore(join(root, 'cache'));
  busy.mockReturnValue(false);
  deletion = new PaperDataDeletion(store, busy);
  await store.initPaper(sha);
  await store.initPaper(other);
  await fs.writeFile(join(root, 'original.pdf'), 'original PDF');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

it('확인한 한 논문의 모든 세대만 삭제하고 원본·다른 논문은 보존한다', async () => {
  await store.writeText(store.generationPath(sha, 'old', 'context.json'), 'old');
  await store.writeText(store.generationPath(sha, 'new', 'context.json'), 'new');
  expect(await deletion.remove(sha, () => Promise.resolve(true))).toBe(true);
  expect(await store.exists(store.paperDir(sha))).toBe(false);
  expect(await store.readManifest(other)).toMatchObject({ pdfSha256: other });
  expect(await fs.readFile(join(root, 'original.pdf'), 'utf8')).toBe('original PDF');
});

it('취소하면 어떤 데이터도 삭제하지 않는다', async () => {
  expect(await deletion.remove(sha, () => Promise.resolve(false))).toBe(false);
  expect(await store.readManifest(sha)).toMatchObject({ pdfSha256: sha });
});

it('확인 대기 중에는 중복 삭제와 새로운 쓰기를 막고 취소 후에는 허용한다', async () => {
  let answer!: (yes: boolean) => void;
  const pending = deletion.remove(sha, () => new Promise((resolve) => (answer = resolve)));
  const write = vi.fn(() => Promise.resolve(undefined));
  await expect(deletion.run(sha, write)).rejects.toThrow('삭제');
  await expect(deletion.remove(sha, () => Promise.resolve(true))).rejects.toThrow('확인 중');
  expect(write).not.toHaveBeenCalled();
  answer(false);
  await pending;
  await deletion.run(sha, write);
  expect(write).toHaveBeenCalledOnce();
});

it('분석 파일 쓰기·백그라운드 작업 중에는 경고창보다 먼저 삭제를 차단한다', async () => {
  const confirm = vi.fn(() => Promise.resolve(true));
  await deletion.run(sha, async () => {
    await expect(deletion.remove(sha, confirm)).rejects.toThrow('진행 중');
  });
  busy.mockReturnValue(true);
  await expect(deletion.remove(sha, confirm)).rejects.toThrow('진행 중');
  expect(confirm).not.toHaveBeenCalled();
  expect(await store.exists(store.paperDir(sha))).toBe(true);
});

it('잘못된 경로 입력은 확인하거나 삭제하지 않는다', async () => {
  const confirm = vi.fn(() => Promise.resolve(true));
  await expect(deletion.remove('../original.pdf', confirm)).rejects.toThrow('invalid sha256');
  expect(confirm).not.toHaveBeenCalled();
});

it('삭제 실패를 전달하며 잠금을 풀어 재시도할 수 있게 한다', async () => {
  vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('permission denied'));
  await expect(deletion.remove(sha, () => Promise.resolve(true))).rejects.toThrow(
    'permission denied',
  );
  expect(deletion.isDeleting(sha)).toBe(false);
  expect(await store.exists(store.paperDir(sha))).toBe(true);
  expect(await deletion.remove(sha, () => Promise.resolve(true))).toBe(true);
});
