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
import type { GetAccountRateLimitsResponse } from '../llm/codex/protocol/v2/GetAccountRateLimitsResponse';
import { runChunk } from './chunk-run';

// 청크 여러 개를 App Server 하나에서 동시에 돌려 시간과 속도 제한을 본다(docs/quality-backlog.md Q10).
// 한도를 쓰므로 기본 검사에서는 돌지 않는다. 청크마다 임시 캐시를 따로 쓴다. manifest 동시 쓰기는 이 실험의 대상이 아니다.
// 실행:
//   PAPERLENS_LLM_LIVE_USERDATA="$HOME/Library/Application Support/paperlens" \
//   PAPERLENS_LIVE_PDF_SHA=<sha256> PAPERLENS_LIVE_CONTEXT=<context.json> PAPERLENS_LIVE_OUT=<dir> \
//   PAPERLENS_LIVE_CHUNKS=0,1,2 \
//   npx vitest run src/main/translate/chunk-parallel.live.test.ts --silent=false --disableConsoleIntercept
const userData = process.env['PAPERLENS_LLM_LIVE_USERDATA'];
const pdfSha = process.env['PAPERLENS_LIVE_PDF_SHA'];
const contextFile = process.env['PAPERLENS_LIVE_CONTEXT'];
const outDir = process.env['PAPERLENS_LIVE_OUT'];
const indices = (process.env['PAPERLENS_LIVE_CHUNKS'] ?? '')
  .split(',')
  .map((v) => v.trim())
  .filter((v) => v !== '')
  .map(Number);

describe.skipIf(!userData || !pdfSha || !contextFile || indices.length === 0)(
  'runChunk 동시 실행 (실제 app-server, 로그인 상태)',
  () => {
    it('고른 청크가 모두 완료된다', async () => {
      const sha = pdfSha ?? '';
      const appStore = new PaperCacheStore(join(userData ?? '', 'cache'));
      const rev = (await appStore.readManifest(sha)).currentExtractionRevision ?? '';
      const document = await appStore.readJson(
        'extractionDocument',
        appStore.extractionPath(sha, rev, 'document.json'),
      );
      const raw = await fs.readFile(contextFile ?? '');
      const parsed = validateCacheDocument('contextDocument', JSON.parse(raw.toString('utf8')));
      if (!parsed.ok) throw new Error(parsed.errors.join('; '));
      const plan = planChunks(document);
      const chunks = indices.map((i) => {
        const chunk = plan.chunks[i];
        if (!chunk) throw new Error(`청크 ${String(i)}가 없습니다 (전체 ${plan.chunks.length})`);
        return chunk;
      });

      const rt = new CodexRuntime({ userDataPath: userData ?? '', appVersion: '0.0.0-test' });
      await rt.start();
      const roots: string[] = [];
      const limits = async (): Promise<string> => {
        const client = rt.client;
        if (!client) throw new Error('App Server에 연결되지 않았습니다');
        const res = await client.request<GetAccountRateLimitsResponse>(
          'account/rateLimits/read',
          {},
        );
        return JSON.stringify(res.rateLimits.primary);
      };
      try {
        console.log(`[live] limits before ${await limits()}`);
        const runner = new CodexJobRunner({
          transport: () => rt.client,
          startThread: (options) => rt.startThread(options),
        });
        const started = Date.now();
        const results = await Promise.all(
          chunks.map(async (chunk) => {
            const root = await fs.mkdtemp(join(tmpdir(), 'paperlens-parallel-live-'));
            roots.push(root);
            const store = new PaperCacheStore(root);
            await store.initPaper(sha);
            await store.updateManifest(sha, (m) => {
              m.currentExtractionRevision = rev;
              m.state = 'translating';
            });
            const at = Date.now();
            const result = await runChunk(
              { store, runner, log: (line) => console.log(`[translate] ${line}`) },
              {
                pdfSha256: sha,
                generationId: 'gen_live',
                document,
                context: parsed.value,
                contextSha256: sha256Hex(raw),
                chunk,
                timeoutMs: 45 * 60_000,
              },
            );
            console.log(
              `[live] chunk=${chunk.id} ok=${String(result.ok)} sentences=${chunk.targetSentenceIds.length} wallMs=${Date.now() - at} usage=${JSON.stringify(result.usage)}`,
            );
            if (!result.ok) console.log(`[live] 실패 ${chunk.id} ${result.code} ${result.message}`);
            if (outDir) {
              await fs.mkdir(outDir, { recursive: true });
              await fs.copyFile(result.chunkPath, join(outDir, `${chunk.id}.json`));
            }
            return result;
          }),
        );
        console.log(`[live] all chunks=${chunks.length} wallMs=${Date.now() - started}`);
        console.log(`[live] limits after ${await limits()}`);
        expect(results.every((r) => r.ok)).toBe(true);
      } finally {
        await rt.stop();
        for (const root of roots) await fs.rm(root, { recursive: true, force: true });
      }
    }, 7_200_000);
  },
);
