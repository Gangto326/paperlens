import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  IPC,
  type AppInfo,
  type ParserHealth,
  type PdfOpenDialogResult,
  type TextExtractionResult,
} from '@shared/ipc';
import { PaperCacheStore } from './cache/paper-cache-store';
import { PdfRegistry } from './pdf/pdf-registry';
import { parseTextExtractionPayload, saveTextItems } from './extract/text-items-store';
import { GrobidClient } from './parser/grobid-client';

let store: PaperCacheStore;
let registry: PdfRegistry;
let grobid: GrobidClient;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    title: 'PaperLens',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  win.on('ready-to-show', () => win.show());

  // PAPERLENS_SCREENSHOT=<png 경로>이면 로드 후 일정 시간 뒤 창을 캡처한다 (개발·자동 검증용).
  const shotPath = process.env['PAPERLENS_SCREENSHOT'];
  if (shotPath) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(
        () => {
          void win.webContents.capturePage().then(async (img) => {
            await writeFile(shotPath, img.toPNG());
            console.log(`[main] screenshot saved ${shotPath}`);
          });
        },
        Number(process.env['PAPERLENS_SCREENSHOT_DELAY_MS'] ?? 4000),
      );
    });
  }

  // PAPERLENS_DEBUG=1이면 renderer 콘솔을 stdout으로 넘긴다 (개발·자동 검증용).
  if (process.env['PAPERLENS_DEBUG']) {
    win.webContents.on('console-message', (details) => {
      console.log(`[renderer:${details.level}] ${details.message}`);
    });
  }

  // 외부 링크는 앱 창이 아니라 시스템 브라우저로만 연다 (http/https만 허용).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

function registerIpc(): void {
  ipcMain.handle(IPC.appInfo, async (): Promise<AppInfo> => {
    const autoPath = process.env['PAPERLENS_OPEN_PDF'];
    const autoOpened = autoPath ? await registry.register(autoPath) : null;
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      platform: process.platform,
      userDataPath: app.getPath('userData'),
      autoOpened,
      screenshotMode: Boolean(process.env['PAPERLENS_SCREENSHOT']),
    };
  });

  ipcMain.handle(IPC.pdfOpenDialog, async (event): Promise<PdfOpenDialogResult> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
      title: '논문 PDF 열기',
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    const path = result.filePaths[0];
    if (result.canceled || !path) return { canceled: true };
    const opened = await registry.register(path);
    return { canceled: false, ...opened };
  });

  ipcMain.handle(IPC.pdfReadBytes, async (_event, pdfSha256: unknown): Promise<Uint8Array> => {
    if (typeof pdfSha256 !== 'string') throw new Error('pdfSha256 must be a string');
    return registry.readBytes(pdfSha256);
  });

  ipcMain.handle(
    IPC.extractSaveTextItems,
    async (_event, payload: unknown): Promise<TextExtractionResult> => {
      const parsed = parseTextExtractionPayload(payload);
      if (!registry.isRegistered(parsed.pdfSha256)) {
        throw new Error(`등록되지 않은 PDF: ${parsed.pdfSha256}`);
      }
      return saveTextItems(store, parsed);
    },
  );

  ipcMain.handle(IPC.parserHealth, (): Promise<ParserHealth> => grobid.isAlive());
}

void app.whenReady().then(() => {
  store = new PaperCacheStore(join(app.getPath('userData'), 'cache'));
  registry = new PdfRegistry(store);
  grobid = new GrobidClient({ timeoutMs: 5_000 });
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
