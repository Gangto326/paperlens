import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaperCacheStore, type CacheReadError } from './paper-cache-store';
import { writeFileAtomic } from './atomic-file';
import { sampleChunk, SAMPLE_SHA } from '@shared/schema/fixtures';

let root: string;
let store: PaperCacheStore;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'paperlens-cache-'));
  store = new PaperCacheStore(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('PaperCacheStore', () => {
  it('initPaper는 manifest를 만들고 두 번째 호출은 기존 것을 돌려준다', async () => {
    const m1 = await store.initPaper(SAMPLE_SHA);
    expect(m1.state).toBe('imported');
    await store.updateManifest(SAMPLE_SHA, (m) => (m.state = 'extracting'));
    const m2 = await store.initPaper(SAMPLE_SHA);
    expect(m2.state).toBe('extracting');
  });

  it('스키마에 맞지 않는 값은 쓰지 않는다', async () => {
    const path = store.generationPath(SAMPLE_SHA, 'gen_1', 'chunks/c1.json');
    // @ts-expect-error 고의로 잘못된 상태값
    await expect(store.writeJson('chunkDocument', path, { ...sampleChunk, status: 'nope' })).rejects.toThrow(
      /검증 실패/,
    );
    expect(await store.exists(path)).toBe(false);
  });

  it('쓰기 도중 실패해도 기존 파일이 손상되지 않고 임시 파일이 남지 않는다', async () => {
    const path = join(root, 'papers', SAMPLE_SHA, 'generations', 'gen_1', 'chunks', 'c1.json');
    await store.writeJson('chunkDocument', path, sampleChunk);
    const before = await fs.readFile(path, 'utf8');

    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk full'));
    await expect(
      store.writeJson('chunkDocument', path, { ...sampleChunk, attempts: 5 }),
    ).rejects.toThrow('disk full');
    expect(renameSpy).toHaveBeenCalled();

    expect(await fs.readFile(path, 'utf8')).toBe(before);
    const leftovers = (await fs.readdir(join(root, 'papers', SAMPLE_SHA, 'generations', 'gen_1', 'chunks'))).filter(
      (n) => n.endsWith('.tmp'),
    );
    expect(leftovers).toEqual([]);
  });

  it('손상된 JSON·해시 불일치·스키마 위반을 구분해 보고한다', async () => {
    const path = join(root, 'x.json');
    const hash = await store.writeJson('chunkDocument', path, sampleChunk);
    await expect(store.readJson('chunkDocument', path, hash)).resolves.toMatchObject({ id: 'chunk_1' });
    await expect(store.readJson('chunkDocument', path, 'f'.repeat(64))).rejects.toMatchObject({
      reason: 'hash_mismatch',
    } satisfies Partial<CacheReadError>);

    await writeFileAtomic(path, '{ not json');
    await expect(store.readJson('chunkDocument', path)).rejects.toMatchObject({ reason: 'invalid_json' });

    await writeFileAtomic(path, JSON.stringify({ ...sampleChunk, status: 'nope' }));
    await expect(store.readJson('chunkDocument', path)).rejects.toMatchObject({ reason: 'schema' });

    await expect(store.readJson('chunkDocument', join(root, 'none.json'))).rejects.toMatchObject({
      reason: 'missing',
    });
  });

  it('verifyFiles는 manifest.files와 실제 파일의 불일치를 찾는다', async () => {
    await store.initPaper(SAMPLE_SHA);
    const chunkPath = store.generationPath(SAMPLE_SHA, 'gen_1', 'chunks/c1.json');
    const hash = await store.writeJson('chunkDocument', chunkPath, sampleChunk);
    await store.updateManifest(SAMPLE_SHA, (m) => store.recordFile(m, SAMPLE_SHA, chunkPath, hash));
    expect(await store.verifyFiles(SAMPLE_SHA)).toEqual([]);

    await fs.writeFile(chunkPath, '{}');
    expect(await store.verifyFiles(SAMPLE_SHA)).toEqual([
      { path: 'generations/gen_1/chunks/c1.json', problem: 'hash_mismatch' },
    ]);
    await fs.rm(chunkPath);
    expect(await store.verifyFiles(SAMPLE_SHA)).toEqual([
      { path: 'generations/gen_1/chunks/c1.json', problem: 'missing' },
    ]);
  });

  it('cleanupTemp는 남은 .tmp 파일만 제거한다', async () => {
    await store.initPaper(SAMPLE_SHA);
    const dir = join(store.paperDir(SAMPLE_SHA), 'generations', 'g');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, '.context.json.123.abcd.tmp'), 'x');
    await fs.writeFile(join(dir, 'keep.json'), 'x');
    const removed = await store.cleanupTemp(SAMPLE_SHA);
    expect(removed).toEqual(['generations/g/.context.json.123.abcd.tmp']);
    expect(await fs.readdir(dir)).toEqual(['keep.json']);
  });
});
