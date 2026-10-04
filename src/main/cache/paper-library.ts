import type { LibraryPaper } from '@shared/ipc';
import { promises as fs } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { CacheReadError, type PaperCacheStore } from './paper-cache-store';

/** 기존 캐시에서 목록을 구성하므로 이전 버전에서 번역한 논문도 바로 나타난다. */
export async function listLibrary(
  store: PaperCacheStore,
  runningSha: string | null,
): Promise<LibraryPaper[]> {
  const papers: LibraryPaper[] = [];
  for (const sha of await store.listPaperHashes()) {
    try {
      const manifest = await store.readManifest(sha);
      if (!manifest.currentGenerationId && manifest.generations.length === 0) continue;
      if (!manifest.currentExtractionRevision) continue;
      const { paper } = await store.readJson(
        'extractionDocument',
        store.extractionPath(sha, manifest.currentExtractionRevision, 'document.json'),
      );
      let path = paper.originalPath ?? null;
      try {
        const source = JSON.parse(
          await fs.readFile(join(store.paperDir(sha), 'source.json'), 'utf8'),
        ) as { originalPath?: unknown } | null;
        if (typeof source?.originalPath === 'string' && isAbsolute(source.originalPath))
          path = source.originalPath;
      } catch {
        // 이전 캐시는 추출 결과에 기록된 원본 위치를 사용한다.
      }
      papers.push({
        pdfSha256: sha,
        title: paper.title?.trim() || paper.fileName,
        fileName: path ? basename(path) : paper.fileName,
        originalPath: path,
        available: path !== null && (await store.exists(path)),
        state: manifest.state,
        running: runningSha === sha,
        updatedAt: manifest.updatedAt,
      });
    } catch (err) {
      // 한 논문의 손상된 캐시 때문에 나머지 목록을 숨기지 않는다.
      if (!(err instanceof CacheReadError)) throw err;
    }
  }
  return papers.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
