import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

// GROBID·계정·논문 없이 첫 실행 안내의 실제 키보드 동작을 검증한다.
test('첫 안내 연습 → 닫기 → 재실행 기억 → 도움말로 다시 열기', async () => {
  const profile = await fs.mkdtemp(join(tmpdir(), 'paperlens-tutorial-'));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${profile}`],
    cwd: resolve(__dirname, '..'),
    env: { ...process.env, PAPERLENS_NO_CODEX: '1', PAPERLENS_OPEN_PDF: '' },
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const dialog = page.locator('#reading-tutorial');
    await expect(dialog).toBeVisible();
    await page.locator('#tutorial-sentence').click();
    await expect(page.locator('#tutorial-translation')).toBeVisible();
    await page.locator('#tutorial-next').click();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#tutorial-example-position')).toHaveText('2 / 3 문장');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#tutorial-example-position')).toHaveText('1 / 3 문장');
    await page.locator('#tutorial-next').click();
    await page.keyboard.press('ArrowDown');
    expect(
      await page
        .locator('#tutorial-scroll')
        .evaluate((el) => (el as unknown as { scrollTop: number }).scrollTop),
    ).toBeGreaterThan(0);
    await page.keyboard.press('ArrowUp');
    expect(
      await page
        .locator('#tutorial-scroll')
        .evaluate((el) => (el as unknown as { scrollTop: number }).scrollTop),
    ).toBe(0);
    await page.locator('#tutorial-next').click();
    for (let count = 1; count <= 3; count++) {
      await page.keyboard.press('Tab');
      await expect(page.locator('#tutorial-concepts details[open]')).toHaveCount(count);
    }
    await page.keyboard.press('Tab');
    await expect(page.locator('#tutorial-back')).toBeFocused();
    await page.locator('#tutorial-next').click();
    await expect(dialog).toBeHidden();
    await page.reload();
    await expect(page.locator('#status')).toHaveText('PDF를 열어 읽기를 시작하세요.');
    await expect(dialog).toBeHidden();
    await page.locator('#btn-help').click();
    await expect(dialog).toBeVisible();
    await expect(page.locator('#tutorial-progress')).toHaveText('읽기 안내 · 1 / 4');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.locator('#btn-help')).toBeFocused();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
});
