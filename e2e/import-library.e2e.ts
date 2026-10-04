import type { PaperLensApi } from '../src/preload';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { sampleExtraction } from '../src/shared/schema/fixtures';
import { sentenceIndexOf } from '../src/shared/mapping/selection';
import type { WorkProgress } from '../src/shared/work-status';

const ROOT = resolve(__dirname, '..');

test('새 논문 확인·취소·자동 번역과 저장된 논문 다시 열기', async () => {
  const profile = await fs.mkdtemp(join(tmpdir(), 'paperlens-import-'));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${profile}`],
    cwd: ROOT,
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
    page.on('pageerror', (err) => errors.push(err.message));
    await page.locator('#tutorial-close').click();
    await app.evaluate(
      ({ ipcMain, dialog, BrowserWindow }, args) => {
        const win = BrowserWindow.getAllWindows()[0]!;
        const counts = { starts: 0, extracts: 0, parserStarts: 0 };
        let indexReady = false;
        let parserReady = false;
        (globalThis as unknown as { importCounts: typeof counts }).importCounts = counts;
        const originalPath = args.pdf;
        dialog.showOpenDialog = () =>
          Promise.resolve({ canceled: false, filePaths: [originalPath] });
        for (const name of [
          'extract:saveTextItems',
          'extract:readDocument',
          'translate:readResults',
          'process:start',
          'process:stop',
          'work:read',
          'library:list',
          'library:open',
          'parser:health',
          'parser:fulltext',
          'extract:buildDocument',
          'deps:startGrobid',
        ])
          ipcMain.removeHandler(name);
        ipcMain.handle('extract:saveTextItems', () => {
          counts.extracts++;
          return {
            itemCount: 50,
            pages: [],
            textQuality: 'ok',
            halted: false,
            extractionRevision: 'test',
          };
        });
        ipcMain.handle('extract:readDocument', () => {
          if (!indexReady) throw new Error('아직 문장 색인 없음');
          return { ...args.index, documentPath: '/test/document.json' };
        });
        ipcMain.handle('parser:health', () =>
          parserReady
            ? { ok: true, version: 'test' }
            : { ok: false, reason: 'unreachable', message: 'test', guidance: 'test' },
        );
        ipcMain.handle('deps:startGrobid', () => {
          parserReady = true;
          counts.parserStarts++;
          return { started: true, message: '' };
        });
        ipcMain.handle('parser:fulltext', () => ({
          byteLength: 10,
          hasSentenceCoords: true,
          parserConfigHash: 'test',
          elapsedMs: 0,
        }));
        ipcMain.handle('extract:buildDocument', () => {
          indexReady = true;
          return { extractionRevision: 'test', sentenceCount: 1, elapsedMs: 0 };
        });
        ipcMain.handle('translate:readResults', (_event, sha: string) => ({
          pdfSha256: sha,
          state: 'mapping',
          generationId: null,
          chunks: [],
          results: {},
        }));
        ipcMain.handle('work:read', (_event, sha: string) => ({
          progress: null,
          preparation: { pdfSha256: sha, status: 'idle', updatedAt: 0, resources: [], message: '' },
        }));
        ipcMain.handle('process:start', (_event, sha: string) => {
          counts.starts++;
          win.webContents.send('test:started', sha);
          return { started: true, reason: null };
        });
        ipcMain.handle('process:stop', () => ({ accepted: true }));
        ipcMain.handle('library:list', () => [
          {
            pdfSha256: 'a'.repeat(64),
            title: '저장된 논문',
            fileName: '2005.11401.pdf',
            state: 'complete',
            running: false,
            available: true,
            originalPath,
            updatedAt: new Date().toISOString(),
          },
        ]);
        ipcMain.handle('library:open', () => {
          return { pdfSha256: args.sha, originalPath, fileName: '2005.11401.pdf', byteLength: 0 };
        });
      },
      {
        pdf: join(ROOT, 'fixtures/papers/2005.11401.pdf'),
        index: sentenceIndexOf(sampleExtraction),
        sha: '',
      },
    );
    // 실제 등록된 해시/바이트 경로를 쓰되, AI와 파서 호출만 고정한다.
    await page.locator('#btn-open').click();
    await expect(page.locator('#import-dialog')).toBeVisible();
    await page.screenshot({ path: '/private/tmp/paperlens-import-dialog.png' });
    await page.getByRole('button', { name: '아니오', exact: true }).click();
    await expect(page.locator('#welcome')).toBeVisible();
    await expect(page.locator('#doc-title')).toHaveText('논문 읽기');
    await expect(page.locator('#process-area')).toBeHidden();
    await expect(page.locator('#viewer .page')).toHaveCount(0);
    expect(
      await app.evaluate(
        () =>
          (globalThis as unknown as { importCounts: { starts: number; extracts: number } })
            .importCounts,
      ),
    ).toEqual({ starts: 0, extracts: 0, parserStarts: 0 });

    await page.locator('#btn-open').click();
    await page.locator('#import-yes').click();
    await expect(page.locator('#status')).toHaveText(
      '번역을 시작했습니다. 끝난 부분부터 표시됩니다.',
      { timeout: 30000 },
    );
    await expect(page.locator('#import-dialog')).toBeHidden();
    expect(
      await app.evaluate(
        () =>
          (globalThis as unknown as { importCounts: { starts: number; extracts: number } })
            .importCounts,
      ),
    ).toEqual({ starts: 1, extracts: 1, parserStarts: 1 });
    await expect(page.locator('#tab-work')).toHaveAttribute('aria-selected', 'true');
    const registered = await page.evaluate(() =>
      (globalThis as unknown as { paperlens: PaperLensApi }).paperlens.openPdfDialog(),
    );
    if (registered.canceled) throw new Error('expected PDF');
    const sha = registered.pdfSha256;
    const now = Date.now();
    const progress: WorkProgress = {
      pdfSha256: sha,
      revision: 10,
      running: true,
      phase: 'translating',
      state: 'translating',
      startedAt: now - 123000,
      endedAt: null,
      lastActivityAt: now,
      step: null,
      completed: 8,
      failed: 0,
      total: 22,
      chunks: Array.from({ length: 22 }, (_, index) => ({
        id: `chunk_${index}`,
        index,
        state: index < 8 ? 'complete' : index < 16 ? 'running' : 'pending',
      })),
      jobs: [],
      history: [{ at: now, text: '8개 구간의 번역과 해설을 저장했습니다.' }],
    };
    await app.evaluate(
      ({ BrowserWindow }, p) =>
        BrowserWindow.getAllWindows()[0]!.webContents.send('work:event', {
          type: 'progress',
          progress: p,
        }),
      progress,
    );
    await expect(page.locator('#work-counts')).toHaveText('8 / 22 구간 · 36%');
    await expect(page.locator('#work-chunks > span')).toHaveCount(22);
    await expect(page.locator('#work-steps [data-state=current]')).toContainText('문장 번역·해설');
    await page.screenshot({ path: '/private/tmp/paperlens-progress-redesign.png' });
    await page.locator('#btn-process').click();
    await expect(page.locator('#stage')).toContainText('진행 중인 구간이 끝나면 멈춥니다');
    await page.setViewportSize({ width: 1000, height: 760 });
    await page.screenshot({ path: '/private/tmp/paperlens-progress-narrow.png' });

    await app.evaluate(
      ({ BrowserWindow }, p) =>
        BrowserWindow.getAllWindows()[0]!.webContents.send('work:event', {
          type: 'progress',
          progress: p,
        }),
      {
        ...progress,
        revision: 11,
        running: false,
        phase: 'finished',
        state: 'complete',
        completed: 22,
        endedAt: Date.now(),
        chunks: progress.chunks.map((chunk) => ({ ...chunk, state: 'complete' })),
      } satisfies WorkProgress,
    );
    await expect(page.locator('#work-counts')).toHaveText('22 / 22 구간 · 100%');
    await expect(page.locator('#work-steps [data-state=done]')).toHaveCount(4);
    await page.screenshot({ path: '/private/tmp/paperlens-progress-complete.png' });

    // 이미 읽던 논문이 있어도 '아니오'는 시작 화면으로 완전히 돌아간다.
    await page.locator('#btn-open').click();
    await page.getByRole('button', { name: '아니오', exact: true }).click();
    await expect(page.locator('#welcome')).toBeVisible();
    await expect(page.locator('#viewer .page')).toHaveCount(0);
    await expect(page.locator('#btn-process')).toBeHidden();

    await app.evaluate(({ ipcMain }, args) => {
      ipcMain.removeHandler('library:open');
      ipcMain.handle('library:open', () => args);
      ipcMain.removeHandler('translate:readResults');
      ipcMain.handle('translate:readResults', () => ({
        pdfSha256: args.pdfSha256,
        state: 'complete',
        generationId: 'g1',
        chunks: [],
        results: {},
      }));
    }, registered);
    await page.locator('#btn-library').click();
    await expect(page.locator('#library-list')).toContainText('저장된 논문');
    await expect(page.locator('#library-list')).toContainText('번역 완료');
    await page.screenshot({ path: '/private/tmp/paperlens-library.png' });
    await page.locator('.library-paper').click();
    await expect(page.locator('#doc-title')).toHaveText('2005.11401.pdf');
    await expect(page.locator('#status')).toContainText('저장된 문장');
    await expect(page.locator('#import-dialog')).toBeHidden();
    await expect(page.locator('#btn-process')).toBeHidden();
    expect(
      await app.evaluate(
        () => (globalThis as unknown as { importCounts: { starts: number } }).importCounts.starts,
      ),
    ).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
});
