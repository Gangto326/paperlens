import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { AdditionalExplanation, AdditionalTarget } from '../src/shared/additional-explanation';
import { additionalSource } from '../src/shared/additional-explanation';
import type { TranslationSnapshot } from '../src/shared/ipc';
import { sampleExtraction } from '../src/shared/schema/fixtures';
import { sentenceIndexOf } from '../src/shared/mapping/selection';

function textPdf(): string {
  const text =
    'BT /F1 12 Tf 50 720 Td (We study retrieval augmented generation and explain its use.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join('');
  return `${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

test('추가 설명 스트리밍, 개별 접기, 문장 이동 및 화면 재로드 후 답변 유지', async () => {
  const profile = await fs.mkdtemp(join(tmpdir(), 'paperlens-extra-e2e-'));
  const pdf = textPdf();
  const original = join(profile, '추가 설명 테스트.pdf');
  await fs.writeFile(original, pdf);
  const sha = createHash('sha256').update(pdf).digest('hex');
  const translation = {
    ko: '검색 증강 생성은 관련 자료를 찾아 답변에 활용합니다.',
    note: '',
    warnings: [],
    chunkId: 'c1',
    conceptIds: ['concept_1'],
    explanation: {
      main: '검색과 생성을 결합합니다.',
      example: '질문과 관련된 문서를 찾아 답변을 만듭니다.',
      caution: '검색 결과도 확인해야 합니다.',
      plain: '',
      role: '',
      deeper: '',
    },
  };
  const snapshot: TranslationSnapshot = {
    pdfSha256: sha,
    state: 'complete',
    generationId: 'g1',
    chunks: [{ id: 'c1', status: 'complete', sentenceIds: ['s_1', 's_2'] }],
    results: { s_1: translation, s_2: translation },
    concepts: {
      concept_1: {
        id: 'concept_1',
        name: 'RAG',
        nameKo: '검색 증강 생성',
        definitionKo: '외부 자료를 찾아 답변에 활용하는 방식입니다.',
        whyItMatters: '질문에 필요한 정보를 제공하기 위해서입니다.',
        exampleKo: null,
        prerequisiteConceptIds: [],
        sourced: false,
      },
    },
    overview: {
      summary: '검색과 생성을 함께 사용합니다.',
      researchQuestion: '',
      contributions: [],
      methodOverview: '',
      mainResults: [],
      limitations: [],
      unresolved: [],
      glossary: [],
    },
  };
  const index = sentenceIndexOf(sampleExtraction);
  // 저장된 문장 색인은 분석기 좌표가 아니라 PDF 사용자 좌표를 사용한다.
  index.sentences[0]!.rects = [
    {
      pageIndex: 0,
      x: 50,
      y: 718,
      width: 320,
      height: 14,
      coordinateSpace: 'pdf_user_space',
      transformVersion: '1',
    },
  ];
  index.sentences.push({ ...index.sentences[0]!, id: 's_2', order: 1 });
  const targets: AdditionalTarget[] = [
    { kind: 'section', sentenceId: 's_1', section: 'main' },
    { kind: 'section', sentenceId: 's_1', section: 'example' },
    { kind: 'section', sentenceId: 's_1', section: 'caution' },
    { kind: 'concept', conceptId: 'concept_1' },
  ];
  const sources = Object.fromEntries(
    targets.map((target) => [JSON.stringify(target), additionalSource(snapshot, target)]),
  );
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${profile}`],
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      PAPERLENS_NO_CODEX: '1',
      PAPERLENS_OPEN_PDF: '',
      PAPERLENS_AUTO_PROCESS: '',
    },
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.locator('#tutorial-close').click();
    // UI 테스트에서는 저장된 번역과 AI 완료 이벤트를 고정한다. 실제 생성·디스크 저장은 서비스 테스트에서 검증한다.
    await app.evaluate(
      ({ ipcMain, dialog, BrowserWindow }, args) => {
        const saved = new Map<string, AdditionalExplanation>();
        dialog.showOpenDialog = () =>
          Promise.resolve({ canceled: false, filePaths: [args.original] });
        for (const channel of [
          'parser:health',
          'extract:readDocument',
          'translate:readResults',
          'additional:read',
          'additional:request',
        ])
          ipcMain.removeHandler(channel);
        ipcMain.handle('parser:health', () => ({
          ok: false,
          reason: 'unreachable',
          message: 'test',
          guidance: 'test',
        }));
        ipcMain.handle('extract:readDocument', () => ({
          ...args.index,
          documentPath: '/test/document.json',
        }));
        ipcMain.handle('translate:readResults', () => args.snapshot);
        ipcMain.handle('additional:read', () => [...saved.values()]);
        ipcMain.handle('additional:request', (_event, sha: string, target: AdditionalTarget) => {
          const key = JSON.stringify(target);
          const known = saved.get(key);
          if (known) return known;
          const source = args.sources[key];
          if (!source) throw new Error('unknown target');
          const state: AdditionalExplanation = {
            pdfSha256: sha,
            target,
            source,
            status: 'running',
            text: null,
            message: 'AI가 설명을 작성하고 있습니다.',
            startedAt: Date.now(),
            updatedAt: Date.now(),
          };
          saved.set(key, state);
          const send = (): void =>
            BrowserWindow.getAllWindows()[0]!.webContents.send('additional:event', state);
          send();
          setTimeout(() => {
            state.previewText = '먼저 관련 자료를 찾습니다.';
            state.updatedAt = Date.now();
            send();
          }, 250);
          setTimeout(() => {
            state.status = 'complete';
            delete state.previewText;
            state.updatedAt = Date.now();
            state.text =
              target.kind === 'concept'
                ? '검색 증강 생성은 참고 자료를 펼쳐 놓고 답하는 방식과 비슷합니다.\n\n1. 질문과 관련된 자료를 찾습니다.\n2. 자료를 참고해 답변을 작성합니다.\n\n찾은 자료가 정확한지도 확인해야 합니다.'
                : '쉽게 말하면, 먼저 필요한 자료를 찾고 그 자료를 읽으며 답을 만드는 과정입니다.\n\n오픈북 시험에서 교재를 찾아본 뒤 답안을 쓰는 상황을 떠올려 보세요.';
            state.message = '저장된 AI 설명';
            send();
          }, 1500);
          return state;
        });
      },
      { original, index, snapshot, sources },
    );
    await page.locator('#btn-open').click();
    await expect(page.locator('#status')).toContainText('문장을 클릭하거나 드래그');
    await page.locator('#btn-sentence-next').click();
    const main = page.locator('#selection .explain-main .additional-explanation');
    await expect(page.locator('#selection .additional-button')).toHaveCount(4);
    const copy = page.locator('#selection .sentence-meta .copy-button');
    const request = main.locator('button');
    const appearance = (el: unknown): Record<string, string> => {
      const node = el as {
        ownerDocument: {
          defaultView: {
            getComputedStyle: (element: unknown) => { getPropertyValue: (name: string) => string };
          };
        };
      };
      const style = node.ownerDocument.defaultView.getComputedStyle(el);
      return Object.fromEntries(
        [
          'fontSize',
          'fontFamily',
          'fontWeight',
          'lineHeight',
          'height',
          'padding',
          'borderColor',
          'borderRadius',
          'backgroundColor',
          'color',
        ].map((key) => [
          key,
          style.getPropertyValue(key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)),
        ]),
      );
    };
    await page.mouse.move(0, 0);
    const normal = await copy.evaluate(appearance);
    expect(normal.fontSize).toBe('10px');
    expect(normal.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    for (const button of await page.locator('#selection .additional-button:visible').all())
      expect(await button.evaluate(appearance)).toEqual(normal);
    await copy.hover();
    await expect
      .poll(() => copy.evaluate(appearance).then((style) => style.backgroundColor))
      .not.toBe('rgba(0, 0, 0, 0)');
    await expect
      .poll(() => copy.evaluate(appearance).then((style) => style.borderColor))
      .toBe('rgb(183, 197, 216)');
    const hovered = await copy.evaluate(appearance);
    await request.hover();
    await expect.poll(() => request.evaluate(appearance)).toEqual(hovered);
    await main.locator('button').click();
    await expect(main).toHaveAttribute('aria-busy', 'true');
    await expect(main.locator('button')).toBeDisabled();
    await expect(main.locator('.additional-status')).toContainText('AI');
    await expect(main.locator('.additional-answer')).toContainText('먼저 관련 자료');
    await expect(main).toHaveAttribute('aria-busy', 'true');
    await expect(main.locator('.additional-summary')).toBeHidden();
    await page.locator('#btn-sentence-next').click();
    await expect(page.locator('#sentence-position')).toHaveText('2 / 2 문장');
    await page.locator('#btn-sentence-prev').click();
    await expect(main.locator('.additional-answer')).toContainText('오픈북 시험');
    await expect(main.locator('.additional-summary')).toHaveText('AI 추가 설명 · 저장됨');
    await expect(main.locator('button')).toBeHidden();
    await main.locator('.additional-summary').click();
    await expect(main.locator('.additional-answer')).toBeHidden();
    await expect(page.locator('#selection .explain-main > .rich')).toBeVisible();
    await page.locator('#btn-sentence-next').click();
    await page.locator('#btn-sentence-prev').click();
    await expect(main.locator('.additional-answer')).toBeHidden();
    await main.locator('.additional-summary').focus();
    await page.keyboard.press('Enter');
    await expect(main.locator('.additional-answer')).toBeVisible();
    await expect(page.locator('#selection .explain-caution .additional-button')).toBeEnabled();
    const concept = page.locator('#selection details.concept');
    await concept.locator(':scope > summary').click();
    await expect
      .poll(() => concept.locator('.additional-button').evaluate(appearance))
      .toEqual(normal);
    await concept.locator('.additional-button').click();
    await expect(concept.locator('.additional-answer')).toContainText('참고 자료');
    await expect(concept.locator('.additional-summary')).toHaveText('AI 추가 설명 · 저장됨');
    await concept.locator('.additional-summary').click();
    await expect(concept.locator('.additional-answer')).toBeHidden();
    await expect(main.locator('.additional-answer')).toBeVisible();
    await page.screenshot({ path: '/tmp/paperlens-additional-explanations.png' });
    await page.locator('#tab-paper').click();
    await page.locator('#notes-tab-concepts').click();
    const noteCard = page.locator('#notes-concepts details.concept');
    await noteCard.locator(':scope > summary').click();
    await expect(noteCard.locator('.additional-answer')).toBeHidden();
    await noteCard.locator('.additional-summary').click();
    await expect(noteCard.locator('.additional-answer')).toContainText('참고 자료');
    await page.reload();
    await page.locator('#btn-open').click();
    await expect(page.locator('#status')).toContainText('문장을 클릭하거나 드래그');
    await page.locator('#btn-sentence-next').click();
    await expect(main.locator('.additional-answer')).toContainText('오픈북 시험');
    await expect(main.locator('.additional-answer')).toBeVisible();
    await expect(main.locator('button')).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
});
