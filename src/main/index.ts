import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { basename, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  IPC,
  type AppInfo,
  type LlmAccountEvent,
  type LlmAccountStatus,
  type LlmLoginCancel,
  type LlmLoginStart,
  type LlmRateLimits,
  type MappingResult,
  type ParserFulltextResult,
  type ParserHealth,
  type PdfOpenDialogResult,
  type ReadDocumentResult,
  type TextExtractionResult,
} from '@shared/ipc';
import { PaperCacheStore } from './cache/paper-cache-store';
import { PdfRegistry } from './pdf/pdf-registry';
import { parseTextExtractionPayload, saveTextItems } from './extract/text-items-store';
import { buildAndSaveDocument, readSentenceIndex } from './extract/document-store';
import type { Page } from '@shared/schema';
import { GrobidClient } from './parser/grobid-client';
import { FULLTEXT_PARAMS, processFulltext, saveOriginalTei } from './parser/grobid-fulltext';
import { CodexRuntime, formatToolInventory } from './llm/codex/codex-runtime';
import { CodexAccount, formatAccountStatus, formatRateLimits } from './llm/codex/codex-account';
import { formatSmokeRecord, runStructuredSmoke, saveSmokeRecord } from './llm/codex/codex-smoke';

let store: PaperCacheStore;
let registry: PdfRegistry;
let grobid: GrobidClient;
/** saveTextItems가 판정한 페이지 정보. document.json(C1.14)에 넣기 전까지 `<sha>:<rev>`로 기억한다. */
const extractedPages = new Map<string, Page[]>();
/** 마지막 헬스체크에서 읽은 GROBID 버전(Pipeline.parserVersion). */
let grobidVersion: string | null = null;
/** 앱이 소유하는 Codex App Server(C1.18). PAPERLENS_NO_CODEX=1이면 띄우지 않는다. */
let codex: CodexRuntime | null = null;
/** 계정·로그인·한도 어댑터(C1.19). 런타임이 없어도 존재하며 그때는 unavailable을 돌려준다. */
const account = new CodexAccount(() => codex?.client ?? null, {
  log: (line) => console.log(`[codex] ${line}`),
});

/**
 * 구조화 출력 스모크(C1.20). 한도를 쓰므로 PAPERLENS_LLM_SMOKE=1일 때만 돈다: 시작 시 로그인 상태면 바로,
 * 아니면 로그인 완료 직후 1회. 결과는 로그와 userData/llm/structured-smoke.json에 남긴다.
 */
let smokeRunning = false;
async function runSmoke(trigger: string): Promise<void> {
  const runtime = codex;
  if (!process.env['PAPERLENS_LLM_SMOKE'] || !runtime || smokeRunning) return;
  smokeRunning = true;
  try {
    console.log(`[codex] smoke 시작 (${trigger})`);
    const record = await runStructuredSmoke({
      transport: () => runtime.client,
      readAccount: () => account.read(),
      startThread: () => runtime.startThread(),
      runtimeVersion: runtime.startInfo?.binary.version ?? null,
      log: (line) => console.log(`[codex] ${line}`),
    });
    console.log(`[codex] ${formatSmokeRecord(record)}`);
    const path = await saveSmokeRecord(app.getPath('userData'), record);
    console.log(`[codex] smoke 기록 ${path}`);
  } catch (err) {
    console.error(`[codex] smoke 실패: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    smokeRunning = false;
  }
}

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
      const result = await saveTextItems(store, parsed, {
        parserConfigHash: grobid.parserConfigHash(FULLTEXT_PARAMS),
      });
      if (!result.halted) {
        extractedPages.set(`${parsed.pdfSha256}:${result.extractionRevision}`, result.pages);
      }
      return result;
    },
  );

  ipcMain.handle(IPC.parserHealth, async (): Promise<ParserHealth> => {
    const health = await grobid.isAlive();
    if (health.ok) grobidVersion = health.version;
    return health;
  });

  // 텍스트 추출(C1.5)이 끝난 논문만 GROBID에 보낸다. TEI 원본은 같은 rev 아래 보존한다.
  ipcMain.handle(
    IPC.parserFulltext,
    async (_event, pdfSha256: unknown): Promise<ParserFulltextResult> => {
      if (typeof pdfSha256 !== 'string' || !registry.isRegistered(pdfSha256)) {
        throw new Error('등록되지 않은 PDF');
      }
      const manifest = await store.readManifest(pdfSha256);
      const rev = manifest.currentExtractionRevision;
      if (!rev) throw new Error(`추출 revision이 없습니다 (state=${manifest.state})`);
      const bytes = await registry.readBytes(pdfSha256);
      const result = await processFulltext(grobid, bytes);
      const teiPath = await saveOriginalTei(store, pdfSha256, rev, result.tei);
      return {
        teiPath,
        byteLength: Buffer.byteLength(result.tei),
        hasSentenceCoords: result.hasSentenceCoords,
        parserConfigHash: result.parserConfigHash,
        elapsedMs: result.elapsedMs,
      };
    },
  );

  // TEI(C1.7)와 source-map(C1.5)을 합쳐 document.json을 확정하고 manifest를 mapping으로 옮긴다(C1.14).
  ipcMain.handle(
    IPC.extractBuildDocument,
    async (_event, pdfSha256: unknown): Promise<MappingResult> => {
      if (typeof pdfSha256 !== 'string' || !registry.isRegistered(pdfSha256)) {
        throw new Error('등록되지 않은 PDF');
      }
      const manifest = await store.readManifest(pdfSha256);
      const rev = manifest.currentExtractionRevision;
      if (!rev) throw new Error(`추출 revision이 없습니다 (state=${manifest.state})`);
      const pages = extractedPages.get(`${pdfSha256}:${rev}`);
      if (!pages) throw new Error('텍스트 추출 결과가 메모리에 없습니다. PDF를 다시 여세요.');
      const originalPath = registry.originalPathOf(pdfSha256);
      const { build: _build, ...result } = await buildAndSaveDocument(store, pdfSha256, {
        fileName: basename(originalPath),
        originalPath,
        pages,
        parserVersion: grobidVersion,
        parserConfigHash: grobid.parserConfigHash(FULLTEXT_PARAMS),
      });
      return result;
    },
  );

  // 확정된 document.json의 문장 색인을 renderer에 보낸다(C1.15 선택 해석·C1.16 표시용).
  ipcMain.handle(
    IPC.extractReadDocument,
    async (_event, pdfSha256: unknown): Promise<ReadDocumentResult> => {
      if (typeof pdfSha256 !== 'string' || !registry.isRegistered(pdfSha256)) {
        throw new Error('등록되지 않은 PDF');
      }
      return readSentenceIndex(store, pdfSha256);
    },
  );

  // 계정·로그인·한도(C1.19). 실제 로그인은 기본 브라우저에서 사용자가 마치고, 완료는 llm:accountEvent로 푸시된다.
  ipcMain.handle(IPC.llmAccountRead, async (): Promise<LlmAccountStatus> => account.read());
  ipcMain.handle(IPC.llmLoginStart, async (): Promise<LlmLoginStart> => {
    const start = await account.startLogin();
    if (start.started) await shell.openExternal(start.authUrl);
    return start;
  });
  ipcMain.handle(IPC.llmLoginCancel, async (_event, loginId: unknown): Promise<LlmLoginCancel> => {
    if (typeof loginId !== 'string') throw new Error('loginId가 없습니다');
    return account.cancelLogin(loginId);
  });
  ipcMain.handle(IPC.llmLogout, async (): Promise<LlmAccountStatus> => account.logout());
  ipcMain.handle(IPC.llmRateLimitsRead, async (): Promise<LlmRateLimits> =>
    account.readRateLimits(),
  );
  account.onEvent((event: LlmAccountEvent) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.llmAccountEvent, event);
    }
    if (event.type === 'loginCompleted' && event.result.success) void runSmoke('로그인 완료');
  });
}

// Codex App Server를 앱 전용 CODEX_HOME으로 띄우고, 도구 없는 스레드의 유효 도구 목록을 로그로 남긴다(C1.18 확인 항목).
async function bootCodex(): Promise<void> {
  if (process.env['PAPERLENS_NO_CODEX']) {
    console.log('[codex] PAPERLENS_NO_CODEX 설정으로 App Server를 띄우지 않습니다');
    return;
  }
  const runtime = new CodexRuntime({
    userDataPath: app.getPath('userData'),
    appVersion: app.getVersion(),
    log: (line) => console.log(`[codex] ${line}`),
  });
  codex = runtime;
  try {
    const info = await runtime.start();
    console.log(
      `[codex] app-server ${info.binary.version} 시작 ${info.startupMs}ms home=${info.home.root} ua=${info.userAgent}`,
    );
    const thread = await runtime.startThread();
    console.log(
      `[codex] thread ${thread.threadId} model=${thread.model} sandbox=${JSON.stringify(thread.sandbox)} approval=${JSON.stringify(thread.approvalPolicy)}`,
    );
    console.log(`[codex] ${formatToolInventory(await runtime.toolInventory(thread.threadId))}`);
    // C1.19: 시작 직후 계정 상태·한도를 확인해 로그로 남기고 renderer에 푸시한다.
    account.attach();
    console.log(`[codex] ${formatAccountStatus(await account.read())}`);
    console.log(`[codex] ${formatRateLimits(await account.readRateLimits())}`);
    await runSmoke('시작');
  } catch (err) {
    console.error(`[codex] 시작 실패: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || !codex || codex.client?.state === 'exited') return;
  quitting = true;
  event.preventDefault();
  void codex
    .stop()
    .catch((err: unknown) => console.error(`[codex] 종료 실패: ${String(err)}`))
    .finally(() => app.quit());
});

void app.whenReady().then(() => {
  store = new PaperCacheStore(join(app.getPath('userData'), 'cache'));
  registry = new PdfRegistry(store);
  grobid = new GrobidClient();
  registerIpc();
  createWindow();
  void bootCodex();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
