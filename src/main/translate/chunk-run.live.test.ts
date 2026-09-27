import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateCacheDocument } from '@shared/schema';
import { sha256Hex } from '../cache/hash';
import { PaperCacheStore } from '../cache/paper-cache-store';
import { planChunks } from '../chunk/chunker';
import { CodexJobRunner } from '../llm/codex/codex-jobs';
import { CodexRuntime } from '../llm/codex/codex-runtime';
import type { LlmJobEvent } from '../llm/job';
import { runChunk } from './chunk-run';

// 로그인된 실제 App Server로 샘플 청크 1개를 번역한다. 한도를 쓰므로 기본 검사에서는 돌지 않는다.
// 앱 캐시의 document.json과 미리 만든 context.json을 읽고, 결과는 임시 캐시에 쓴다.
// 실행:
//   PAPERLENS_LLM_LIVE_USERDATA="$HOME/Library/Application Support/paperlens" \
//   PAPERLENS_LIVE_PDF_SHA=<sha256> PAPERLENS_LIVE_CONTEXT=<context.json> PAPERLENS_LIVE_OUT=<dir> \
//   [PAPERLENS_LIVE_CHUNK=<0부터>] \
//   npx vitest run src/main/translate/chunk-run.live.test.ts --silent=false --disableConsoleIntercept
const userData = process.env['PAPERLENS_LLM_LIVE_USERDATA'];
const pdfSha = process.env['PAPERLENS_LIVE_PDF_SHA'];
const contextFile = process.env['PAPERLENS_LIVE_CONTEXT'];
const outDir = process.env['PAPERLENS_LIVE_OUT'];
const chunkIndex = Number(process.env['PAPERLENS_LIVE_CHUNK'] ?? '0');

describe.skipIf(!userData || !pdfSha || !contextFile)(
  'runChunk (실제 app-server, 로그인 상태)',
  () => {
    it('샘플 1개 청크가 완료된다', async () => {
      const sha = pdfSha ?? '';
      const appStore = new PaperCacheStore(join(userData ?? '', 'cache'));
      const appManifest = await appStore.readManifest(sha);
      const rev = appManifest.currentExtractionRevision ?? '';
      const document = await appStore.readJson(
        'extractionDocument',
        appStore.extractionPath(sha, rev, 'document.json'),
      );
      const raw = await fs.readFile(contextFile ?? '');
      const parsed = validateCacheDocument('contextDocument', JSON.parse(raw.toString('utf8')));
      if (!parsed.ok) throw new Error(parsed.errors.join('; '));
      const plan = planChunks(document);
      const chunk = plan.chunks[chunkIndex];
      if (!chunk) throw new Error(`청크 ${chunkIndex}가 없습니다 (전체 ${plan.chunks.length})`);

      const root = await fs.mkdtemp(join(tmpdir(), 'paperlens-chunk-live-'));
      const store = new PaperCacheStore(root);
      await store.initPaper(sha);
      await store.updateManifest(sha, (m) => {
        m.currentExtractionRevision = rev;
        m.state = 'translating';
      });
      const rt = new CodexRuntime({ userDataPath: userData ?? '', appVersion: '0.0.0-test' });
      await rt.start();
      try {
        const runner = new CodexJobRunner({
          transport: () => rt.client,
          startThread: (options) => rt.startThread(options),
        });
        let chars = 0;
        const onEvent = (e: LlmJobEvent): void => {
          if (e.type === 'output') chars = e.chars;
        };
        const result = await runChunk(
          { store, runner, log: (line) => console.log(`[translate] ${line}`) },
          {
            pdfSha256: sha,
            generationId: 'gen_live',
            document,
            context: parsed.value,
            contextSha256: sha256Hex(raw),
            chunk,
            onEvent,
          },
        );
        console.log(
          `[live] chunk=${chunk.id} ok=${String(result.ok)} outputChars=${chars} usage=${JSON.stringify(result.usage)}`,
        );
        if (outDir) {
          await fs.mkdir(outDir, { recursive: true });
          await fs.copyFile(result.chunkPath, join(outDir, `${chunk.id}.json`));
          if (!result.ok && result.rawText !== null) {
            await fs.writeFile(join(outDir, `${chunk.id}.failed.raw.json`), result.rawText);
          }
        }
        if (!result.ok) console.log(`[live] 실패 ${result.code} ${result.message}`);
        expect(result.ok).toBe(true);
        expect(result.chunk.status).toBe('complete');
        expect(result.chunk.results).toHaveLength(chunk.targetSentenceIds.length);
        expect(await store.verifyFiles(sha)).toEqual([]);
      } finally {
        await rt.stop();
        await fs.rm(root, { recursive: true, force: true });
      }
    }, 900_000);
  },
);
