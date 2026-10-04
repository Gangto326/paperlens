import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { sampleExtraction } from '@shared/schema/fixtures';
import { PaperCacheStore } from './paper-cache-store';
import { listLibrary } from './paper-library';

let root: string;
let store: PaperCacheStore;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'paperlens-library-'));
  store = new PaperCacheStore(join(root, 'cache'));
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

async function seed(sha: string, state: 'complete' | 'paused', missing = false) {
  await store.initPaper(sha);
  const path = join(root, `${sha}.pdf`);
  if (!missing) await fs.writeFile(path, 'pdf');
  await store.writeJson('extractionDocument', store.extractionPath(sha, 'rev', 'document.json'), {
    ...sampleExtraction,
    paper: {
      ...sampleExtraction.paper,
      pdfSha256: sha,
      title: `논문 ${sha[0]}`,
      originalPath: path,
    },
  });
  await store.updateManifest(sha, (m) => {
    m.state = state;
    m.currentExtractionRevision = 'rev';
    m.currentGenerationId = 'gen';
  });
}

it('이전 캐시의 완료·중단 논문을 재실행 후에도 읽고 새로 등록만 한 PDF는 제외한다', async () => {
  await seed('a'.repeat(64), 'complete');
  await seed('b'.repeat(64), 'paused');
  await store.initPaper('c'.repeat(64));
  const papers = await listLibrary(new PaperCacheStore(join(root, 'cache')), 'b'.repeat(64));
  expect(papers).toHaveLength(2);
  expect(papers.find((p) => p.state === 'complete')).toMatchObject({
    title: '논문 a',
    available: true,
    running: false,
  });
  expect(papers.find((p) => p.state === 'paused')).toMatchObject({ running: true });
});

it('원본이 사라져도 번역 목록은 남고, 손상된 캐시는 다른 논문을 가리지 않는다', async () => {
  await seed('a'.repeat(64), 'complete', true);
  await store.initPaper('b'.repeat(64));
  await fs.writeFile(store.manifestPath('b'.repeat(64)), 'broken');
  expect(await listLibrary(store, null)).toMatchObject([{ available: false, title: '논문 a' }]);
});

it('첫 실행은 빈 목록을 돌려준다', async () => {
  expect(await listLibrary(store, null)).toEqual([]);
});

it('다시 선택한 원본 위치를 다음 실행의 목록에서도 사용한다', async () => {
  const sha = 'a'.repeat(64);
  await seed(sha, 'complete', true);
  const moved = join(root, 'moved.pdf');
  await fs.writeFile(moved, 'pdf');
  await store.writeText(
    join(store.paperDir(sha), 'source.json'),
    JSON.stringify({ originalPath: moved }),
  );
  expect(await listLibrary(new PaperCacheStore(join(root, 'cache')), null)).toMatchObject([
    { originalPath: moved, fileName: 'moved.pdf', available: true },
  ]);
});
