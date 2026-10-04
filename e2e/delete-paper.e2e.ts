import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { PaperLensApi } from '../src/preload';

// 빈 1쪽 PDF: 분석 서버·LLM 없이 실제 PDF 열기와 삭제 IPC를 검증한다.
function blankPdf(): string {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += 'xref\n0 4\n0000000000 65535 f \n';
  pdf += offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join('');
  return `${pdf}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

test('현재 논문 삭제: 경고·취소·확인·화면 초기화·원본 및 다른 논문 보존', async () => {
  const profile = await fs.mkdtemp(join(tmpdir(), 'paperlens-delete-e2e-'));
  const pdf = blankPdf();
  const original = join(profile, '삭제 테스트.pdf');
  const sha = createHash('sha256').update(pdf).digest('hex');
  const cache = join(profile, 'cache', 'papers', sha);
  const other = join(profile, 'cache', 'papers', 'b'.repeat(64));
  await fs.writeFile(original, pdf);
  await fs.mkdir(other, { recursive: true });
  await fs.writeFile(join(other, 'keep.json'), 'other paper');
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${profile}`],
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      PAPERLENS_NO_CODEX: '1',
      PAPERLENS_OPEN_PDF: original,
      PAPERLENS_AUTO_PROCESS: '',
    },
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.locator('#tutorial-close').click();
    const button = page.locator('#btn-delete-paper');
    await expect(button).toBeEnabled();
    const saved = join(cache, 'generations', 'test');
    await fs.mkdir(saved, { recursive: true });
    await fs.writeFile(join(saved, 'context.json'), 'cached translation');
    await page.evaluate((id) => {
      localStorage.setItem(`paperlens-bookmarks-v1:${id}`, '[]');
    }, sha);

    // 네이티브 경고의 실제 옵션을 검사하고 취소 응답을 반환한다.
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (
        ...args: [Electron.MessageBoxOptions] | [Electron.BaseWindow, Electron.MessageBoxOptions]
      ) => {
        const options = args.length === 2 ? args[1] : args[0];
        if (
          !options ||
          options.type !== 'warning' ||
          options.defaultId !== 0 ||
          options.cancelId !== 0
        )
          throw new Error('삭제 경고의 안전한 기본값이 누락됐습니다');
        if (
          !options.message.includes('삭제 테스트.pdf') ||
          !options.detail?.includes('되돌릴 수 없으며')
        )
          throw new Error('삭제 대상과 경고가 누락됐습니다');
        if (options.buttons?.join(',') !== '취소,삭제') throw new Error('확인 버튼이 누락됐습니다');
        return Promise.resolve({ response: 0, checkboxChecked: false });
      };
    });
    await button.click();
    await expect(button).toBeEnabled();
    expect(await fs.readFile(join(saved, 'context.json'), 'utf8')).toBe('cached translation');
    await expect(page.locator('#doc-title')).toHaveText('삭제 테스트.pdf');

    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = () => Promise.resolve({ response: 1, checkboxChecked: false });
    });
    await button.click();
    await expect(page.locator('#status')).toContainText('저장 데이터를 삭제했습니다');
    await expect(button).toBeDisabled();
    await expect(page.locator('#welcome')).toBeVisible();
    await expect(page.locator('#viewer .page')).toHaveCount(0);
    await expect(page.locator('#process-area')).toBeHidden();
    expect(await fs.stat(cache).catch(() => null)).toBeNull();
    expect(await fs.readFile(original, 'utf8')).toBe(pdf);
    expect(await fs.readFile(join(other, 'keep.json'), 'utf8')).toBe('other paper');
    expect(
      await page.evaluate((id) => localStorage.getItem(`paperlens-bookmarks-v1:${id}`), sha),
    ).toBe('[]');
    const stale = await page.evaluate(async (id) => {
      const { paperlens } = globalThis as unknown as { paperlens: PaperLensApi };
      return paperlens.startProcessing(id).then(
        () => 'unexpected',
        () => 'rejected',
      );
    }, sha);
    expect(stale).toBe('rejected');
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
    }, original);
    await page.locator('#btn-open').click();
    await expect(page.locator('#import-dialog')).toBeVisible();
    await page.locator('#import-yes').click();
    await expect(button).toBeEnabled();
    await expect(page.locator('#doc-title')).toHaveText('삭제 테스트.pdf');
    expect(await fs.stat(join(cache, 'manifest.json')).then(() => true)).toBe(true);
    expect(await fs.stat(saved).catch(() => null)).toBeNull();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
});
