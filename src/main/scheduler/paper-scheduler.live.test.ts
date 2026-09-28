import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Manifest } from '@shared/schema';
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
// PAPERLENS_LIVE_RESEARCH=1이면 조사 전용 런타임을 함께 띄워 개념 카드 조사를 돌린다(PLAN 3.3.1).
const withResearch = Boolean(process.env['PAPERLENS_LIVE_RESEARCH']);
// 앞서 만든 세대 폴더(PAPERLENS_LIVE_OUT으로 받은 것)를 주면 그 context.json을 심어 1차 패스를 건너뛴다.
// 프롬프트 버전이 다르면 스케줄러가 쓰지 않고 새로 만든다.
const seedDir = process.env['PAPERLENS_LIVE_SEED_CONTEXT'];
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

    if (seedDir) {
      const seedManifest = JSON.parse(
        await fs.readFile(join(seedDir, 'manifest.json'), 'utf8'),
      ) as Manifest;
      const seeded = seedManifest.generations.find(
        (g) => g.generationId === seedManifest.currentGenerationId,
      );
      if (!seeded) throw new Error('심을 세대를 manifest에서 찾지 못했습니다');
      const context = await new PaperCacheStore(root).readJson(
        'contextDocument',
        join(seedDir, 'context.json'),
      );
      const contextPath = store.generationPath(sha, seeded.generationId, 'context.json');
      const contextSha = await store.writeJson('contextDocument', contextPath, context);
      await store.updateManifest(sha, (m) => {
        store.recordFile(m, sha, contextPath, contextSha);
        m.generations.push(seeded);
        m.currentGenerationId = seeded.generationId;
        m.state = 'context_pending';
      });
      console.log(`[live] 컨텍스트를 심음 generation=${seeded.generationId}`);
    }

    const rt = new CodexRuntime({ userDataPath: userData ?? '', appVersion: '0.0.0-test' });
    const info = await rt.start();
    const researchRt = withResearch
      ? new CodexRuntime({
          userDataPath: userData ?? '',
          appVersion: '0.0.0-test',
          profile: 'research',
        })
      : null;
    if (researchRt) await researchRt.start();
    try {
      const runner = new CodexJobRunner({
        transport: () => rt.client,
        startThread: (options) => rt.startThread(options),
        ...(researchRt
          ? {
              research: {
                transport: () => researchRt.client,
                startThread: (options) => researchRt.startThread(options),
              },
            }
          : {}),
      });
      const scheduler = new PaperScheduler({
        store,
        runner,
        provider: 'codex',
        runtimeVersion: () => info.binary.version,
        research: withResearch ? 'builtin_web' : 'none',
        log: (line) => console.log(`[process] ${line}`),
      });
      const outcome = await scheduler.run(sha);
      const manifest = await store.readManifest(sha);
      console.log(
        `[live] reason=${outcome.reason} state=${manifest.state} chunks=${outcome.completedChunks}/${outcome.totalChunks} failed=${outcome.failedChunks} firstTranslationMs=${String(outcome.firstTranslationMs)} elapsedMs=${outcome.elapsedMs}`,
      );
      console.log(`[live] context usage=${JSON.stringify(outcome.contextUsage)}`);
      console.log(`[live] research usage=${JSON.stringify(outcome.researchUsage)}`);
      for (const b of outcome.researchBatches) console.log(`[live] research ${JSON.stringify(b)}`);
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
      await researchRt?.stop();
      await rt.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 7_200_000);
});
