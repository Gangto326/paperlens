import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';

/**
 * Electron 최소 시나리오(COMMIT_PLAN C5.5): 열기 → 추출 → 선택 → 원문 표시.
 * 확대·축소와 드래그로 여러 문장 선택(C5.2의 자동화 가능한 부분)도 본다.
 * GROBID가 127.0.0.1:8070에 떠 있어야 한다. 없으면 건너뛴다. LLM은 쓰지 않는다(PAPERLENS_NO_CODEX).
 * 세 시나리오는 같은 창을 이어 쓴다. 하나가 실패하면 Playwright가 앱을 새로 띄워 뒤 시나리오가 추출 전 화면에서
 * 돌게 되므로, 순서대로만 돌리고 앞이 실패하면 뒤는 건너뛴다.
 * 실행: npm run build && npm run e2e
 */
const ROOT = resolve(__dirname, '..');
const PDF = join(ROOT, 'fixtures', 'papers', '2005.11401.pdf');

const grobidAlive = async (): Promise<boolean> => {
  try {
    const res = await fetch('http://127.0.0.1:8070/api/isalive', {
      signal: AbortSignal.timeout(2_000),
    });
    return (await res.text()).trim() === 'true';
  } catch {
    return false;
  }
};

test.describe.configure({ mode: 'serial' });

/** 1쪽 초록의 줄(텍스트 항목 하나 = 한 줄). 앞쪽 항목은 제목·저자라 문장에 연결돼 있지 않다. */
const line = (text: string): Locator =>
  page.locator('.textLayer [data-item-id]', { hasText: text }).first();
const FIRST = 'Large pre-trained language models'; // 초록 첫 문장이 시작하는 줄
const SECOND = 'However, their ability to access'; // 가운데가 둘째 문장인 줄
const THIRD = 'Additionally, providing provenance'; // 끝이 셋째 문장인 줄

let app: ElectronApplication;
let page: Page;
let userData: string;

test.beforeAll(async () => {
  test.skip(!(await grobidAlive()), 'GROBID가 떠 있지 않아 건너뜀');
  test.skip(
    !(await fs.stat(PDF).catch(() => null)),
    '검증 논문 PDF가 없음 (npm run fixtures:download)',
  );
  userData = await fs.mkdtemp(join(tmpdir(), 'paperlens-e2e-'));
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: ROOT,
    env: { ...process.env, PAPERLENS_NO_CODEX: '1', PAPERLENS_OPEN_PDF: PDF },
  });
  page = await app.firstWindow();
});

test.afterAll(async () => {
  await app?.close();
  if (userData) await fs.rm(userData, { recursive: true, force: true });
});

test('열기 → 추출 → 문장 연결 → 클릭 선택 → 원문 표시', async () => {
  test.setTimeout(240_000);
  await expect(page.locator('#doc-title')).toContainText('2005.11401.pdf', { timeout: 60_000 });
  // 추출과 GROBID 구조 분석, 문장 연결까지 기다린다.
  await expect(page.locator('#status')).toContainText('문장을 클릭하거나 드래그', {
    timeout: 180_000,
  });
  await expect(page.locator('#stage')).not.toContainText('열는 중');
  await line(FIRST).click();
  await expect(page.locator('#selection .selection-summary')).toContainText('문장 1개', {
    timeout: 10_000,
  });
  await expect(page.locator('#selection .sentence')).toHaveCount(1);
  await expect(page.locator('#selection .sentence-en')).toContainText(FIRST);
});

test('확대한 화면에서도 클릭한 문장이 선택되고, 축소하면 배율이 돌아온다', async () => {
  const before = (await page.locator('#zoom-label').textContent()) ?? '';
  await page.locator('#btn-zoom-in').click();
  await expect(page.locator('#zoom-label')).not.toHaveText(before);
  // 배율이 바뀌면 텍스트 레이어를 다시 그린다. 다시 그려진 줄을 눌러 다른 문장으로 바뀌는지 본다.
  await line(SECOND).click();
  await expect(page.locator('#selection .sentence-en')).toContainText(SECOND, { timeout: 10_000 });
  await expect(page.locator('#selection .sentence')).toHaveCount(1);
  await page.locator('#btn-zoom-out').click();
  await expect(page.locator('#zoom-label')).toHaveText(before);
});

test('드래그하면 걸친 문장이 모두 선택된다', async () => {
  // 축소로 텍스트 레이어가 다시 그려졌다. 좌표를 재기 전에 화면 안으로 들인다.
  await line(FIRST).scrollIntoViewIfNeeded();
  const a = await line(FIRST).boundingBox();
  const b = await line(THIRD).boundingBox();
  expect(a && b).toBeTruthy();
  if (!a || !b) return;
  await page.mouse.move(a.x + 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('#selection .selection-summary')).toContainText('문장 3개', {
    timeout: 10_000,
  });
  const en = page.locator('#selection .sentence-en');
  await expect(en).toHaveCount(3);
  await expect(en.nth(0)).toContainText(FIRST);
  await expect(en.nth(1)).toContainText(SECOND);
  await expect(en.nth(2)).toContainText(THIRD);
});
