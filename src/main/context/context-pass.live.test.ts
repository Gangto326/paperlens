import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PaperCacheStore } from '../cache/paper-cache-store';
import { CodexJobRunner } from '../llm/codex/codex-jobs';
import { CodexRuntime } from '../llm/codex/codex-runtime';
import type { LlmJobEvent } from '../llm/job';
import { runContextPass } from './context-pass';

// 로그인된 실제 App Server로 샘플 1편의 컨텍스트를 만든다. 한도를 쓰므로 기본 검사에서는 돌지 않는다.
// 앱 캐시의 document.json을 임시 캐시로 복사해 실행한다. 앱 캐시에는 쓰지 않는다.
// 실행:
//   PAPERLENS_LLM_LIVE_USERDATA="$HOME/Library/Application Support/paperlens" \
//   PAPERLENS_LIVE_PDF_SHA=<sha256> PAPERLENS_LIVE_OUT=<dir> \
//   npx vitest run src/main/context/context-pass.live.test.ts --silent=false --disableConsoleIntercept
const userData = process.env['PAPERLENS_LLM_LIVE_USERDATA'];
const pdfSha = process.env['PAPERLENS_LIVE_PDF_SHA'];
const outDir = process.env['PAPERLENS_LIVE_OUT'];

describe.skipIf(!userData || !pdfSha)('runContextPass (실제 app-server, 로그인 상태)', () => {
  it('샘플 1편에서 context.json이 생기고 용어집 항목이 있다', async () => {
    const sha = pdfSha ?? '';
    const appStore = new PaperCacheStore(join(userData ?? '', 'cache'));
    const appManifest = await appStore.readManifest(sha);
    const rev = appManifest.currentExtractionRevision ?? '';
    const document = await appStore.readJson(
      'extractionDocument',
      appStore.extractionPath(sha, rev, 'document.json'),
    );

    const root = await fs.mkdtemp(join(tmpdir(), 'paperlens-context-live-'));
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
        log: (line) => console.log(`[job] ${line}`),
      });
      const stages: string[] = [];
      let chars = 0;
      const onEvent = (e: LlmJobEvent): void => {
        if (e.type === 'stage') stages.push(`${e.stage}:${e.state}`);
        if (e.type === 'output') chars = e.chars;
      };
      const result = await runContextPass(
        {
          store,
          runner,
          provider: 'codex',
          runtimeVersion: info.binary.version,
          log: (line) => console.log(`[context] ${line}`),
        },
        { pdfSha256: sha, onEvent },
      );
      console.log(`[live] stages=${stages.join(',')} outputChars=${chars}`);
      if (!result.ok) {
        console.log(`[live] 실패 ${JSON.stringify({ ...result, rawText: undefined })}`);
        if (outDir && result.rawText !== null) {
          await fs.mkdir(outDir, { recursive: true });
          await fs.writeFile(join(outDir, 'context.failed.raw.json'), result.rawText);
        }
      }
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      console.log(
        `[live] generation=${result.generationId} model=${String(result.model)} glossary=${result.context.glossary.length} unresolved=${result.context.unresolved.length} coverage=${result.context.coverage.length} notes=${result.notes.length} usage=${JSON.stringify(result.usage)}`,
      );
      if (outDir) {
        await fs.mkdir(outDir, { recursive: true });
        await fs.copyFile(result.contextPath, join(outDir, 'context.json'));
        await fs.writeFile(join(outDir, 'notes.json'), JSON.stringify(result.notes, null, 1));
      }
      expect(result.context.glossary.length).toBeGreaterThan(0);
      expect(await store.verifyFiles(sha)).toEqual([]);
    } finally {
      await rt.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 900_000);
});
