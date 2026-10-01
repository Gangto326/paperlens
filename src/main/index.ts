import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { basename, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  IPC,
  type AppInfo,
  type DependencyReport,
  type StartGrobidResult,
  type LlmAccountEvent,
  type LlmAccountStatus,
  type LlmLoginCancel,
  type LlmLoginStart,
  type LlmRateLimits,
  type MappingResult,
  type ParserFulltextResult,
  type ParserHealth,
  type PdfOpenDialogResult,
  type ProcessEvent,
  type ProcessStart,
  type ProcessStop,
  type ReadDocumentResult,
  type TextExtractionResult,
  type TranslationSnapshot,
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
import { CodexJobRunner } from './llm/codex/codex-jobs';
import { coalesce } from './deps/coalesce';
import { checkDocker, startGrobidContainer } from './deps/docker';
import { RetryingJobRunner } from './llm/retrying-runner';
import { AutoResume } from './scheduler/auto-resume';
import { PaperScheduler, type SchedulerEvent } from './scheduler/paper-scheduler';
import { readTranslations } from './translate/results-store';

let store: PaperCacheStore;
let registry: PdfRegistry;
let grobid: GrobidClient;
/** saveTextItems가 판정한 페이지 정보. document.json(C1.14)에 넣기 전까지 `<sha>:<rev>`로 기억한다. */
const extractedPages = new Map<string, Page[]>();
/** 마지막 헬스체크에서 읽은 GROBID 버전(Pipeline.parserVersion). */
let grobidVersion: string | null = null;
/** 앱이 소유하는 Codex App Server(C1.18). PAPERLENS_NO_CODEX=1이면 띄우지 않는다. */
let codex: CodexRuntime | null = null;
/** 조사 전용 런타임(PLAN 3.3.1). 내장 검색이 켜진 별도 프로세스다. 번역 작업은 이 런타임을 쓰지 않는다. */
let codexResearch: CodexRuntime | null = null;
const researchEnabled = !process.env['PAPERLENS_NO_RESEARCH'];
/** 계정·로그인·한도 어댑터(C1.19). 런타임이 없어도 존재하며 그때는 unavailable을 돌려준다. */
const account = new CodexAccount(() => codex?.client ?? null, {
  log: (line) => console.log(`[codex] ${line}`),
});

/** 구조화 작업 실행기(C2.1)와 논문 단위 스케줄러(C2.8). 런타임이 없으면 작업이 unavailable로 끝난다. */
const jobs = new CodexJobRunner({
  transport: () => codex?.client ?? null,
  startThread: (options) => {
    if (!codex) return Promise.reject(new Error('LLM 런타임이 실행 중이 아닙니다'));
    return codex.startThread(options);
  },
  research: {
    transport: () => codexResearch?.client ?? null,
    startThread: (options) => {
      if (!codexResearch) {
        return Promise.reject(new Error('조사 전용 LLM 런타임이 실행 중이 아닙니다'));
      }
      return codexResearch.startThread(options);
    },
  },
  log: (line) => console.log(`[llm] ${line}`),
});
let scheduler: PaperScheduler | null = null;
let autoResume: AutoResume | null = null;
/** 멈춤 요청이 왔는지. 재시도 어댑터가 기다리기 전에 본다. 처리를 시작할 때 되돌린다. */
let stopRequested = false;

/** 스케줄러 이벤트 → renderer용 이벤트. 사용량·청크 계획 같은 내부 값은 보내지 않는다. */
function toProcessEvent(event: SchedulerEvent): ProcessEvent | null {
  switch (event.type) {
    case 'started':
      return null;
    case 'state':
      return event;
    case 'context':
      return {
        type: 'context',
        pdfSha256: event.pdfSha256,
        status: event.status,
        message: event.message,
        ...(event.progress ? { progress: event.progress } : {}),
      };
    case 'research':
      return {
        type: 'research',
        pdfSha256: event.pdfSha256,
        status: event.status,
        researched: event.researched,
        sources: event.sources,
        message: event.message,
        ...(event.progress ? { progress: event.progress } : {}),
      };
    case 'plan':
      return { type: 'plan', pdfSha256: event.pdfSha256, total: event.chunkIds.length };
    case 'chunk_started':
      return {
        type: 'chunkStarted',
        pdfSha256: event.pdfSha256,
        chunkId: event.chunkId,
        total: event.total,
      };
    case 'chunk_finished':
      return {
        type: 'chunkFinished',
        pdfSha256: event.pdfSha256,
        chunkId: event.chunkId,
        ok: event.ok,
        completed: event.completed,
        failed: event.failed,
        total: event.total,
        sentenceIds: event.sentenceIds,
      };
    case 'finished':
      return {
        type: 'finished',
        pdfSha256: event.pdfSha256,
        reason: event.outcome.reason,
        message: event.outcome.message,
        state: event.state,
        completed: event.outcome.completedChunks,
        failed: event.outcome.failedChunks,
        total: event.outcome.totalChunks,
      };
  }
}

/** 처리를 백그라운드로 시작한다. 끝날 때까지 기다리지 않는다. */
function startProcessing(pdfSha256: string, trigger: string): ProcessStart {
  if (!scheduler) return { started: false, reason: '스케줄러가 준비되지 않았습니다' };
  if (!codex || codex.client?.state !== 'running') {
    return { started: false, reason: 'LLM 런타임이 실행 중이 아닙니다' };
  }
  if (scheduler.runningPaper !== null) {
    return {
      started: false,
      reason:
        scheduler.runningPaper === pdfSha256 ? '이미 처리 중입니다' : '다른 논문을 처리 중입니다',
    };
  }
  console.log(`[process] 시작 ${pdfSha256.slice(0, 8)} (${trigger})`);
  stopRequested = false;
  // 사용자가 직접 시작했으면 자동 재개의 기다림은 끝난다.
  autoResume?.cancel();
  void scheduler
    .run(pdfSha256)
    .catch((err: unknown) =>
      console.error(`[process] 실패: ${err instanceof Error ? err.message : String(err)}`),
    );
  return { started: true, reason: null };
}

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
      const index = await readSentenceIndex(store, pdfSha256);
      // 개발·E2E용: PAPERLENS_AUTO_PROCESS=1이면 문장 색인을 읽은 직후 번역 처리를 시작한다(한도를 쓴다).
      if (process.env['PAPERLENS_AUTO_PROCESS']) {
        const started = startProcessing(pdfSha256, 'PAPERLENS_AUTO_PROCESS');
        if (!started.started) console.log(`[process] 시작하지 않음: ${String(started.reason)}`);
      }
      return index;
    },
  );

  // 저장된 번역 결과(C2.9). 캐시 파일만 읽고 LLM을 부르지 않는다.
  ipcMain.handle(
    IPC.translateReadResults,
    async (_event, pdfSha256: unknown): Promise<TranslationSnapshot> => {
      if (typeof pdfSha256 !== 'string' || !registry.isRegistered(pdfSha256)) {
        throw new Error('등록되지 않은 PDF');
      }
      return readTranslations(store, pdfSha256);
    },
  );

  // 번역 처리(C2.8). 시작은 곧바로 돌아오고 진행은 process:event로 푸시한다.
  ipcMain.handle(IPC.processStart, (_event, pdfSha256: unknown): ProcessStart => {
    if (typeof pdfSha256 !== 'string' || !registry.isRegistered(pdfSha256)) {
      throw new Error('등록되지 않은 PDF');
    }
    return startProcessing(pdfSha256, 'renderer');
  });
  ipcMain.handle(IPC.processStop, (): ProcessStop => {
    const accepted = scheduler?.requestStop() ?? false;
    if (accepted) stopRequested = true;
    return { accepted };
  });
  scheduler = new PaperScheduler({
    store,
    // 네트워크·서버 오류는 5·15·45초 뒤 다시 보낸다(C5.3). 멈춤 요청이 오면 기다리지 않는다.
    runner: new RetryingJobRunner({
      inner: jobs,
      shouldContinue: () => !stopRequested,
      log: (line) => console.log(`[process] ${line}`),
    }),
    provider: 'codex',
    runtimeVersion: () => codex?.startInfo?.binary.version ?? 'unknown',
    research: researchEnabled ? 'builtin_web' : 'none',
    log: (line) => console.log(`[process] ${line}`),
  });
  const pushProcessEvent = (payload: ProcessEvent): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.processEvent, payload);
    }
  };
  scheduler.onEvent((event) => {
    const payload = toProcessEvent(event);
    if (payload) pushProcessEvent(payload);
    // 한도·로그인으로 멈추면 앱이 실행 중인 동안 풀리기를 기다렸다가 다시 시작한다(C3.5).
    if (event.type === 'finished' && autoResume) {
      if (event.outcome.reason === 'waiting_quota') void autoResume.waitForQuota(event.pdfSha256);
      else if (event.outcome.reason === 'needs_login') autoResume.waitForLogin(event.pdfSha256);
    }
  });
  autoResume = new AutoResume({
    readRateLimits: () => account.readRateLimits(),
    start: (pdfSha256, trigger) => startProcessing(pdfSha256, trigger),
    onAccountEvent: (handler) => account.onEvent(handler),
    log: (line) => console.log(`[process] ${line}`),
  });
  autoResume.onChange((status) =>
    pushProcessEvent({
      type: 'waiting',
      pdfSha256: status.kind === 'none' ? null : status.pdfSha256,
      kind: status.kind,
      resumeAt: status.kind === 'quota' ? status.resumeAt : null,
    }),
  );

  // 의존 서비스 점검(C5.1). 설치는 하지 않는다. GROBID는 받아 둔 이미지가 있을 때만 띄운다.
  // 바깥 프로그램을 띄우는 부분(docker 명령, GROBID 응답 확인)은 호출이 몰려도 실행이 늘지 않게 묶는다.
  // 방금 결과를 다시 쓰는 2초는 사람이 "다시 확인"을 누르는 간격보다 짧고, GROBID 준비를 기다리는 5초 간격보다 짧다.
  const probeServices = coalesce(() => Promise.all([checkDocker(), grobid.isAlive()]), {
    reuseMs: 2_000,
  });
  ipcMain.handle(IPC.depsCheck, async (): Promise<DependencyReport> => {
    // 계정은 다시 읽지 않는다. 읽으면 계정 이벤트가 나고, renderer가 그 이벤트로 점검을 다시 불러 순환한다.
    const [docker, grobidHealth] = await probeServices();
    const accountStatus = account.lastStatus;
    if (grobidHealth.ok) grobidVersion = grobidHealth.version;
    return {
      docker,
      grobid: grobidHealth,
      codex: {
        runtime: process.env['PAPERLENS_NO_CODEX']
          ? 'disabled'
          : codex?.client?.state === 'running'
            ? 'running'
            : 'stopped',
        account: accountStatus,
      },
      checkedAt: new Date().toISOString(),
    };
  });
  ipcMain.handle(IPC.depsStartGrobid, (): Promise<StartGrobidResult> => startGrobidContainer());

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
  if (!researchEnabled) {
    console.log('[codex-research] PAPERLENS_NO_RESEARCH 설정으로 조사 런타임을 띄우지 않습니다');
    return;
  }
  const research = new CodexRuntime({
    userDataPath: app.getPath('userData'),
    appVersion: app.getVersion(),
    profile: 'research',
    log: (line) => console.log(`[codex-research] ${line}`),
  });
  codexResearch = research;
  try {
    const info = await research.start();
    const thread = await research.startThread();
    console.log(
      `[codex-research] app-server ${info.binary.version} 시작 ${info.startupMs}ms ${formatToolInventory(await research.toolInventory(thread.threadId))}`,
    );
  } catch (err) {
    // 조사 런타임이 없어도 번역은 된다. 개념 카드는 일반 설명으로 남는다.
    console.error(
      `[codex-research] 시작 실패: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

let quitting = false;
app.on('before-quit', (event) => {
  const live = [codex, codexResearch].filter(
    (r): r is CodexRuntime => r !== null && r.client !== null && r.client.state !== 'exited',
  );
  if (quitting || live.length === 0) return;
  quitting = true;
  event.preventDefault();
  void Promise.all(
    live.map((r) =>
      r.stop().catch((err: unknown) => console.error(`[codex] 종료 실패: ${String(err)}`)),
    ),
  ).finally(() => app.quit());
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
