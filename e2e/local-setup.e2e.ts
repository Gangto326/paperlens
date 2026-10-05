import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

// UI-only simulation: no installations, real Docker mutations, account access or GPT requests.
test('초보자 설치 안내·동의·진행·중단·GPT 추천·Windows 안내', async () => {
  const profile = await fs.mkdtemp(join(tmpdir(), 'paperlens-setup-ui-'));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${profile}`],
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      PAPERLENS_NO_CODEX: '1',
      PAPERLENS_NO_SETUP_AUTOSTART: '1',
      PAPERLENS_OPEN_PDF: '',
    },
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ ipcMain }) => {
      let state = {
        platform: 'darwin',
        arch: 'arm64',
        memoryGB: 16,
        phase: 'idle',
        busy: false,
        message: '처음 한 번 준비하면 이 컴퓨터에서 논문을 분석할 수 있습니다.',
        errorCode: null,
        progress: null,
        autoStart: false,
      };
      for (const name of ['setup:read', 'setup:action', 'setup:help']) ipcMain.removeHandler(name);
      ipcMain.handle('setup:read', () => state);
      ipcMain.handle('setup:action', (_event, action) => {
        state = {
          ...state,
          phase: action === 'cancel' ? 'cancelled' : 'downloading_docker',
          busy: action !== 'cancel',
          autoStart: action !== 'cancel',
          message:
            action === 'cancel' ? '준비를 중단했습니다.' : 'Docker 설치 파일을 받고 있습니다.',
        };
        return state;
      });
      ipcMain.handle('setup:help', () => ({
        explanation: 'Docker 창을 확인하고 준비를 이어가세요.',
        action: 'open_docker',
      }));
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.reload();
    await expect(page.locator('#reading-tutorial')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.locator('#btn-setup').click();
    const dialog = page.locator('#local-setup');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#setup-instructions')).toContainText('Applications');
    const prepare = page.locator('[data-setup="prepare"]');
    await expect(prepare).toBeDisabled();
    await page.locator('#setup-consent').check();
    await expect(prepare).toBeEnabled();
    await page.screenshot({ path: 'test-results/setup-mac.png' });
    await prepare.click();
    await expect(prepare).toBeDisabled();
    await expect(page.locator('#setup-progress')).toBeVisible();
    await page.locator('[data-setup="cancel"]').click();
    await expect(page.locator('#setup-message')).toContainText('중단');
    await page.getByText('진단 결과와 GPT 도움', { exact: true }).click();
    await page.locator('#setup-ask').click();
    await expect(page.locator('#setup-answer')).toContainText('Docker 창');
    await expect(page.locator('#setup-recommendation button')).toHaveText('Docker 열기');
    // Receiving GPT advice has no side effect.
    await expect(page.locator('#setup-message')).toContainText('중단');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.locator('#btn-setup')).toBeFocused();
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('setup:read');
      ipcMain.handle('setup:read', () => ({
        platform: 'win32',
        arch: 'x64',
        memoryGB: 8,
        phase: 'install_docker',
        busy: true,
        message: 'Windows 설치 안내를 따라주세요.',
        errorCode: null,
        progress: null,
        autoStart: true,
      }));
    });
    await page.locator('#btn-setup').click();
    await expect(page.locator('#setup-instructions')).toContainText('WSL 2');
    await expect(page.locator('[data-setup="install_wsl"]')).toBeVisible();
    await page.screenshot({ path: 'test-results/setup-windows.png' });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
});

// The Codex decision loop is unit-tested separately; exercise the UI's authorization and event flow.
test('Codex 진단 자동 해결의 동의·진행·중단·실제 결과 표시', async () => {
  const profile = await fs.mkdtemp(join(tmpdir(), 'paperlens-agent-ui-'));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${profile}`],
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      PAPERLENS_NO_CODEX: '1',
      PAPERLENS_NO_SETUP_AUTOSTART: '1',
      PAPERLENS_OPEN_PDF: '',
    },
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ ipcMain }) => {
      const idle = { busy: false, phase: 'idle', message: '', diagnosis: null, history: [] };
      for (const name of ['setup:agentRead', 'setup:agentStart', 'setup:agentCancel'])
        ipcMain.removeHandler(name);
      ipcMain.handle('setup:agentRead', () => idle);
      ipcMain.handle('setup:agentStart', (_event, _question, consent) => {
        if (consent !== true) throw new Error('동의가 필요합니다.');
        return {
          ...idle,
          busy: true,
          phase: 'working',
          message: 'Docker 실행 상태를 확인하고 필요한 준비를 진행합니다.',
        };
      });
      ipcMain.handle('setup:agentCancel', () => ({
        ...idle,
        phase: 'cancelled',
        message: '자동 해결을 중단했습니다.',
      }));
    });
    await expect(page.locator('#reading-tutorial')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.locator('#btn-setup').click();
    const start = page.locator('#setup-agent-start');
    await expect(start).toBeDisabled();
    await page.locator('#setup-consent').check();
    await start.click();
    await expect(page.locator('#setup-agent-status')).toContainText('Docker 실행 상태');
    await expect(start).toBeDisabled();
    await expect(page.locator('[data-setup="prepare"]')).toBeDisabled();
    await page.locator('#setup-agent-stop').click();
    await expect(page.locator('#setup-agent-status')).toContainText('중단');
    await expect(start).toBeEnabled();
    await start.click();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send('setup:agentEvent', {
        busy: false,
        phase: 'ready',
        message: '분석기의 실제 응답을 확인했습니다.',
        diagnosis: {
          checkedAt: new Date().toISOString(),
          platform: 'darwin',
          arch: 'arm64',
          osVersion: '26',
          memoryGB: 16,
          freeDiskGB: 34,
          desktopInstalled: true,
          docker: { reachable: true, engine: 'linux', imagePresent: true },
          container: {
            exists: true,
            managed: true,
            compatible: true,
            running: true,
            oomKilled: false,
            exitCode: 0,
          },
          grobidHealthy: true,
          portOpen: true,
          wsl: 'not_applicable',
          virtualization: 'unknown',
          signals: [],
          setupPhase: 'ready',
          setupBusy: false,
          setupError: null,
        },
        history: [
          {
            action: 'prepare',
            explanation: '분석기 이미지가 없어 다운로드하고 실행했습니다.',
            result: '응답 확인 완료',
          },
        ],
      });
    });
    await expect(page.locator('#setup-agent-status')).toContainText('실제 응답');
    await page.getByText('진단 결과와 GPT 도움', { exact: true }).click();
    await expect(page.locator('#setup-diagnosis')).toContainText('34GB');
    await expect(page.locator('#setup-agent-history')).toContainText('다운로드하고 실행');
    await page.locator('#setup-agent-history').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/setup-agent.png' });
  } finally {
    await app.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
});
