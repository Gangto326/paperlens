import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PaperCacheStore } from '../cache/paper-cache-store';
import { evaluateTranslation, formatEvaluation } from './translation-eval';

// 저장된 세대의 용어 일관성·ID 정합성 평가(C2.11). 캐시 파일만 읽는다. LLM을 부르지 않는다.
// 실행: PAPERLENS_EVAL_CACHE=<cache 폴더> [PAPERLENS_EVAL_PDF_SHA=<sha256>] npm run eval:translation
//   cache 폴더는 papers/<sha>/manifest.json이 든 곳이다. 앱 캐시는 "$HOME/Library/Application Support/paperlens/cache".
//   sha를 주지 않으면 세대가 있는 논문을 모두 평가한다.
const cacheRoot = process.env['PAPERLENS_EVAL_CACHE'];
const only = process.env['PAPERLENS_EVAL_PDF_SHA'];

describe.skipIf(!cacheRoot)('저장된 번역 평가', () => {
  it('ID 불일치 0건, 용어집 위반 0건', async () => {
    const root = cacheRoot ?? '';
    const store = new PaperCacheStore(root);
    const all = only ? [only] : await fs.readdir(join(root, 'papers'));
    let evaluated = 0;
    let idProblems = 0;
    let violations = 0;
    for (const sha of all) {
      if (!/^[0-9a-f]{64}$/.test(sha)) continue;
      const manifest = await store.readManifest(sha);
      const rev = manifest.currentExtractionRevision;
      const generationId = manifest.currentGenerationId;
      if (!rev || !generationId) continue;
      const hashOf = (rel: string): string | undefined =>
        manifest.files.find((f) => f.path === rel)?.sha256;
      const document = await store.readJson(
        'extractionDocument',
        store.extractionPath(sha, rev, 'document.json'),
        hashOf(join('extraction', rev, 'document.json')),
      );
      const context = await store.readJson(
        'contextDocument',
        store.generationPath(sha, generationId, 'context.json'),
        hashOf(join('generations', generationId, 'context.json')),
      );
      const prefix = join('generations', generationId, 'chunks');
      const chunks = [];
      for (const file of manifest.files
        .filter((f) => f.path.startsWith(prefix))
        .sort((a, b) => a.path.localeCompare(b.path))) {
        chunks.push(
          await store.readJson('chunkDocument', join(store.paperDir(sha), file.path), file.sha256),
        );
      }
      const evaluation = evaluateTranslation({ document, context, chunks });
      evaluated += 1;
      idProblems += evaluation.idProblems.length;
      violations += evaluation.termViolations.length;
      console.log(`[eval] ${sha.slice(0, 8)} state=${manifest.state} generation=${generationId}`);
      for (const line of formatEvaluation(evaluation, 40)) console.log(`[eval] ${line}`);
    }
    console.log(`[eval] 논문 ${evaluated}편, ID 불일치 ${idProblems}건, 용어 위반 ${violations}건`);
    expect(evaluated).toBeGreaterThan(0);
    expect(idProblems).toBe(0);
    expect(violations).toBe(0);
  });
});
