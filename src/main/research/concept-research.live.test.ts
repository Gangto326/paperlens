import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateCacheDocument } from '@shared/schema';
import { PaperCacheStore } from '../cache/paper-cache-store';
import { CodexJobRunner } from '../llm/codex/codex-jobs';
import { CodexRuntime } from '../llm/codex/codex-runtime';
import { runConceptResearch } from './concept-research';

// 로그인된 실제 App Server로 개념 카드 몇 개만 조사한다. 한도를 쓰므로 기본 검사에서는 돌지 않는다.
// 앱 캐시의 document.json과 미리 만든 context.json을 읽고, 결과는 임시 캐시에 쓴 뒤 PAPERLENS_LIVE_OUT에 복사한다.
// 고른 카드의 글은 조사의 입력으로 쓰인다. 출처는 이번 조사의 것으로 바뀐다.
// 실행:
//   PAPERLENS_LLM_LIVE_USERDATA="$HOME/Library/Application Support/paperlens" \
//   PAPERLENS_LIVE_PDF_SHA=<sha256> PAPERLENS_LIVE_CONTEXT=<context.json> PAPERLENS_LIVE_OUT=<dir> \
//   PAPERLENS_LIVE_CONCEPTS=c_6,c_7 \
//   npx vitest run src/main/research/concept-research.live.test.ts --silent=false --disableConsoleIntercept
const userData = process.env['PAPERLENS_LLM_LIVE_USERDATA'];
// PAPERLENS_LIVE_CACHE를 주면 document.json을 그 캐시 루트에서 읽는다.
const cacheRoot = process.env['PAPERLENS_LIVE_CACHE'] ?? join(userData ?? '', 'cache');
const pdfSha = process.env['PAPERLENS_LIVE_PDF_SHA'];
const contextFile = process.env['PAPERLENS_LIVE_CONTEXT'];
const outDir = process.env['PAPERLENS_LIVE_OUT'];
const conceptIds = (process.env['PAPERLENS_LIVE_CONCEPTS'] ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter((id) => id !== '');
const GEN = 'gen_live';

describe.skipIf(!userData || !pdfSha || !contextFile || conceptIds.length === 0)(
  'runConceptResearch (실제 app-server, 로그인 상태)',
  () => {
    it('고른 개념 카드의 조사가 끝난다', async () => {
      const sha = pdfSha ?? '';
      const appStore = new PaperCacheStore(cacheRoot);
      const rev = (await appStore.readManifest(sha)).currentExtractionRevision ?? '';
      const document = await appStore.readJson(
        'extractionDocument',
        appStore.extractionPath(sha, rev, 'document.json'),
      );
      const raw = await fs.readFile(contextFile ?? '', 'utf8');
      const parsed = validateCacheDocument('contextDocument', JSON.parse(raw));
      if (!parsed.ok) throw new Error(parsed.errors.join('; '));
      const concepts = parsed.value.concepts.filter((c) => conceptIds.includes(c.id));
      if (concepts.length === 0) throw new Error('고른 id의 카드가 없습니다');

      const root = await fs.mkdtemp(join(tmpdir(), 'paperlens-research-live-'));
      const store = new PaperCacheStore(root);
      await store.initPaper(sha);
      const documentPath = store.extractionPath(sha, rev, 'document.json');
      const documentSha = await store.writeJson('extractionDocument', documentPath, document);
      const contextPath = store.generationPath(sha, GEN, 'context.json');
      const contextSha = await store.writeJson('contextDocument', contextPath, {
        ...parsed.value,
        concepts,
      });
      await store.updateManifest(sha, (m) => {
        store.recordFile(m, sha, documentPath, documentSha);
        store.recordFile(m, sha, contextPath, contextSha);
        m.currentExtractionRevision = rev;
        m.currentGenerationId = GEN;
        m.state = 'context_pending';
      });

      const rt = new CodexRuntime({
        userDataPath: userData ?? '',
        appVersion: '0.0.0-test',
        profile: 'research',
      });
      await rt.start();
      try {
        const runner = new CodexJobRunner({
          transport: () => rt.client,
          startThread: (options) => rt.startThread(options),
          research: {
            transport: () => rt.client,
            startThread: (options) => rt.startThread(options),
          },
        });
        const before = await rt.client?.request('account/rateLimits/read', {});
        console.log(`[live] rateLimits(before)=${JSON.stringify(before)}`);
        const result = await runConceptResearch(
          { store, runner, log: (line) => console.log(`[research] ${line}`) },
          { pdfSha256: sha, generationId: GEN, batchSize: concepts.length },
        );
        const after = await rt.client?.request('account/rateLimits/read', {});
        console.log(`[live] rateLimits(after)=${JSON.stringify(after)}`);
        console.log(`[live] status=${result.status}`);
        if (result.status !== 'done') throw new Error(JSON.stringify(result));
        console.log(
          `[live] researched=${result.researched} sources=${result.sources} usage=${JSON.stringify(result.usage)}`,
        );
        for (const b of result.batches) console.log(`[live] batch ${JSON.stringify(b)}`);
        if (outDir) {
          await fs.mkdir(outDir, { recursive: true });
          for (const file of ['context.json', 'research.json'] as const) {
            await fs.copyFile(store.generationPath(sha, GEN, file), join(outDir, file));
          }
        }
        expect(result.batches.every((b) => b.ok)).toBe(true);
      } finally {
        await rt.stop();
        await fs.rm(root, { recursive: true, force: true });
      }
    }, 1_800_000);
  },
);
