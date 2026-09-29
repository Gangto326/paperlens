import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PaperCacheStore } from '../cache/paper-cache-store';
import { readTranslations } from '../translate/results-store';
import {
  drawReviewSample,
  formatReviewSheet,
  formatReviewSummary,
  parseReviewSheet,
  summarizeReview,
} from './explanation-review';

// 해설 표본 검토(R4.7). 캐시 파일만 읽는다. LLM을 부르지 않는다. 쓰는 법은 docs/review-checklist.md.
// 시트 만들기:
//   PAPERLENS_EVAL_CACHE=<cache 폴더> PAPERLENS_EVAL_PDF_SHA=<sha256> PAPERLENS_REVIEW_OUT=<폴더> npm run eval:review
//   <폴더>에 sample.json과 review-sheet.md를 쓴다. review-sheet.md가 이미 있으면 덮어쓰지 않고 실패한다.
//   PAPERLENS_REVIEW_SIZE(기본 30)와 PAPERLENS_REVIEW_SEED로 크기와 씨앗을 바꾼다.
// 판정 세기:
//   PAPERLENS_REVIEW_SHEET=<review-sheet.md> npm run eval:review
const cacheRoot = process.env['PAPERLENS_EVAL_CACHE'];
const pdfSha = process.env['PAPERLENS_EVAL_PDF_SHA'];
const outDir = process.env['PAPERLENS_REVIEW_OUT'];
const sheetPath = process.env['PAPERLENS_REVIEW_SHEET'];
const size = process.env['PAPERLENS_REVIEW_SIZE'];
const seed = process.env['PAPERLENS_REVIEW_SEED'];

describe.skipIf(!(cacheRoot && pdfSha && outDir))('해설 표본 검토 시트 만들기', () => {
  it('표본을 뽑아 sample.json과 review-sheet.md를 쓴다', async () => {
    const store = new PaperCacheStore(cacheRoot ?? '');
    const sha = pdfSha ?? '';
    const out = outDir ?? '';
    const manifest = await store.readManifest(sha);
    const rev = manifest.currentExtractionRevision;
    if (!rev) throw new Error('추출 결과가 없는 논문이다');
    const document = await store.readJson(
      'extractionDocument',
      store.extractionPath(sha, rev, 'document.json'),
      manifest.files.find((f) => f.path === join('extraction', rev, 'document.json'))?.sha256,
    );
    const snapshot = await readTranslations(store, sha);
    const sample = drawReviewSample({
      document,
      snapshot,
      ...(size ? { size: Number(size) } : {}),
      ...(seed ? { seed } : {}),
    });
    await fs.mkdir(out, { recursive: true });
    const sheet = join(out, 'review-sheet.md');
    // 적어 둔 판정을 지우지 않는다. 'wx'는 파일이 있으면 실패한다.
    await fs.writeFile(sheet, formatReviewSheet(sample), { flag: 'wx' });
    await fs.writeFile(join(out, 'sample.json'), `${JSON.stringify(sample, null, 2)}\n`);
    const withCards = sample.items.filter((i) => i.concepts.length > 0).length;
    console.log(
      `[review] ${sha.slice(0, 8)} generation=${String(sample.generationId)} 후보 ${String(sample.candidates)}문장, 표본 ${String(sample.items.length)}개(개념 카드가 붙은 것 ${String(withCards)}개)`,
    );
    console.log(`[review] ${sheet}`);
    expect(sample.items.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!sheetPath)('해설 표본 검토 판정 세기', () => {
  it('모두 판정했고 이해한 비율이 80% 이상이다', async () => {
    const parsed = parseReviewSheet(await fs.readFile(sheetPath ?? '', 'utf8'));
    const summary = summarizeReview(parsed);
    for (const line of formatReviewSummary(summary, parsed)) console.log(`[review] ${line}`);
    expect(summary.passed).toBe(true);
  });
});
