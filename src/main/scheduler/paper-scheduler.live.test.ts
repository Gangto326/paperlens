import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PaperCacheStore } from '../cache/paper-cache-store';
import { CodexJobRunner } from '../llm/codex/codex-jobs';
import { CodexRuntime } from '../llm/codex/codex-runtime';
import { PaperScheduler } from './paper-scheduler';

// 로그인된 실제 App Server로 샘플 1편을 끝까지 처리한다. 한도를 많이 쓰므로 기본 검사에서는 돌지 않는다.
// 앱 캐시의 document.json을 임시 캐시로 복사해 실행하고, 결과 세대 디렉터리를 PAPERLENS_LIVE_OUT에 복사한다.
// 실행:
//   PAPERLENS_LLM_LIVE_USERDATA="$HOME/Library/Application Support/paperlens" \
//   PAPERLENS_LIVE_PDF_SHA=<sha256> PAPERLENS_LIVE_RUN=1 PAPERLENS_LIVE_OUT=<dir> \
//   npx vitest run src/main/scheduler/paper-scheduler.live.test.ts --silent=false --disableConsoleIntercept
const userData = process.env['PAPERLENS_LLM_LIVE_USERDATA'];
const pdfSha = process.env['PAPERLENS_LIVE_PDF_SHA'];
const outDir = process.env['PAPERLENS_LIVE_OUT'];
const enabled = Boolean(userData && pdfSha && process.env['PAPERLENS_LIVE_RUN']);

describe.skipIf(!enabled)('PaperScheduler (실제 app-server, 로그인 상태)', () => {
  it('샘플 1편을 완주한다', async () => {
    const sha = pdfSha ?? '';
    const appStore = new PaperCacheStore(join(userData ?? '', 'cache'));
    const rev = (await appStore.readManifest(sha)).currentExtractionRevision ?? '';
    const document = await appStore.readJson(
      'extractionDocument',
      appStore.extractionPath(sha, rev, 'document.json'),
    );
    const root = await fs.mkdtemp(join(tmpdir(), 'paperlens-scheduler-live-'));
    const store = new PaperCacheStore(root);
    await store.initPaper(sha);
    const documentPath = store.extractionPath(sha, rev, 'document.json');
    const hash = await store.writeJson('extractionDocument', documentPath, document);
    await store.updateManifest(sha, (m) => {
      store.recordFile(m, sha, documentPath, hash);
      m.currentExtractionRevision = rev;
      m.state = 'mapping';
    });

    const rt = new CodexRuntime({ userDataPath: userData ?? '', appVersion: '0.0.0-test' });
    const info = await rt.start();
    try {
      const runner = new CodexJobRunner({
        transport: () => rt.client,
        startThread: (options) => rt.startThread(options),
      });
      const scheduler = new PaperScheduler({
        store,
        runner,
        provider: 'codex',
        runtimeVersion: () => info.binary.version,
        log: (line) => console.log(`[process] ${line}`),
      });
      const outcome = await scheduler.run(sha);
      const manifest = await store.readManifest(sha);
      console.log(
        `[live] reason=${outcome.reason} state=${manifest.state} chunks=${outcome.completedChunks}/${outcome.totalChunks} failed=${outcome.failedChunks} firstTranslationMs=${String(outcome.firstTranslationMs)} elapsedMs=${outcome.elapsedMs}`,
      );
      console.log(`[live] context usage=${JSON.stringify(outcome.contextUsage)}`);
      for (const m of outcome.metrics) console.log(`[live] ${JSON.stringify(m)}`);
      console.log(`[live] total usage=${JSON.stringify(manifest.usage)}`);
      if (outDir && outcome.generationId) {
        await fs.rm(outDir, { recursive: true, force: true });
        await fs.cp(join(store.paperDir(sha), 'generations', outcome.generationId), outDir, {
          recursive: true,
        });
        await fs.copyFile(store.manifestPath(sha), join(outDir, 'manifest.json'));
      }
      expect(outcome.reason).toBe('complete');
      expect(manifest.state).toBe('complete');
      expect(await store.verifyFiles(sha)).toEqual([]);
    } finally {
      await rt.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 3_600_000);
});
