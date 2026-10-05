import { additionalSource, parseAdditionalTarget } from '@shared/additional-explanation';
import { AdditionalExplanations } from './explanations/additional-explanations';
import type { ReadingWork, WorkUpdate } from '@shared/work-status';
import { WorkProgressTracker } from './scheduler/work-progress';
import { PreparationService } from './research/preparation';
import { completionNotice } from './scheduler/completion-notification';
import { app, BrowserWindow, dialog, ipcMain, shell, Notification } from 'electron';
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
import { listLibrary } from './cache/paper-library';
import { sha256File } from './cache/hash';
import { PaperDataDeletion } from './cache/paper-data-deletion';
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
import { checkDocker } from './deps/docker';
import { createLocalSetup } from './deps/setup-runtime';
import { SetupAgent } from './deps/setup-agent';
import { SetupAssistant } from './deps/setup-assistant';
import { SETUP_ACTIONS, type SetupAction } from '@shared/local-setup';
import { RetryingJobRunner } from './llm/retrying-runner';
import { AutoResume } from './scheduler/auto-resume';
import { PaperScheduler, type SchedulerEvent } from './scheduler/paper-scheduler';
import { readTranslations } from './translate/results-store';

let store: PaperCacheStore;
let registry: PdfRegistry;
let paperDeletion: PaperDataDeletion;
let grobid: GrobidClient;
let setupAgent: SetupAgent;
let parsingPapers = 0;
let localSetup: Awaited<ReturnType<typeof createLocalSetup>>;
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
const setupAssistant = new SetupAssistant(jobs);
let scheduler: PaperScheduler | null = null;
let autoResume: AutoResume | null = null;
/** 멈춤 요청이 왔는지. 재시도 어댑터가 기다리기 전에 본다. 처리를 시작할 때 되돌린다. */
let stopRequested = false;
const publishWork = (payload: WorkUpdate): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.workEvent, payload);
  }
};
const workProgress = new WorkProgressTracker((progress) =>
  publishWork({ type: 'progress', progress }),
);
let preparation: PreparationService;
let additionalExplanations: AdditionalExplanations;
const completionNotifications = new Set<Notification>();

function notifyCompletion(event: SchedulerEvent): void {
  const notice = completionNotice(event);
  if (!notice) return;
  const fileName = basename(registry.originalPathOf(event.pdfSha256));
  const openPaper = async (): Promise<void> => {
    const opened = await registry.register(registry.originalPathOf(event.pdfSha256));
    let win = BrowserWindow.getAllWindows()[0];
    if (!win) {
      win = createWindow();
      await new Promise<void>((resolve) =>
        win!.webContents.once('did-finish-load', () => resolve()),
      );
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send(IPC.openCompletedPaper, opened);
  };
  let fallbackShown = false;
  // 미서명 개발 앱에서도 완료를 놓치지 않도록 앱 팝업으로 알린다.
  const fallback = (): void => {
    if (fallbackShown) return;
    fallbackShown = true;
    app.dock?.bounce('informational');
    void dialog
      .showMessageBox({
        type: 'info',
        title: notice.title,
        message: `${fileName}\n${notice.title}`,
        detail: notice.body,
        buttons: ['논문 읽기', '나중에'],
        defaultId: 0,
        cancelId: 1,
      })
      .then((result) => {
        if (result.response === 0) return openPaper();
      })
      .catch(console.error);
  };
  publishWork({
    type: 'notification',
    pdfSha256: event.pdfSha256,
    message: `${fileName} · ${notice.title}`,
  });
  if (!Notification.isSupported()) {
    fallback();
    return;
  }
  try {
    const notification = new Notification({
      title: notice.title,
      subtitle: fileName,
      body: notice.body,
      silent: false,
    });
    completionNotifications.add(notification);
    notification.on('failed', () => {
      completionNotifications.delete(notification);
      fallback();
    });
    notification.on('close', () => completionNotifications.delete(notification));
    notification.on('click', () => {
      void openPaper().catch(console.error);
    });
    notification.show();
  } catch {
    fallback();
  }
}

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
  if (!registry.isRegistered(pdfSha256) || paperDeletion.isDeleting(pdfSha256))
    return { started: false, reason: '논문이 닫혔거나 데이터 삭제를 확인 중입니다.' };
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
  void scheduler.run(pdfSha256).catch((err: unknown) => {
    console.error(`[process] 실패: ${err instanceof Error ? err.message : String(err)}`);
    workProgress.fail(
      pdfSha256,
      '처리 중 오류가 발생했습니다. 저장된 결과는 유지됩니다. 다시 시작해 주세요.',
    );
  });
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
  paperDeletion = new PaperDataDeletion(
    store,
    (sha) =>
      scheduler?.runningPaper === sha ||
      preparation?.isRunning(sha) ||
      additionalExplanations?.isRunning(sha),
  );
  const runPaperTask = <T>(sha: string, action: () => Promise<T>): Promise<T> => {
    if (!registry.isRegistered(sha)) throw new Error('등록되지 않은 PDF');
    return paperDeletion.run(sha, action);
  };
  additionalExplanations = new AdditionalExplanations(
    store,
    jobs,
    async (sha, target) => {
      const snapshot = await readTranslations(store, sha);
      const source = additionalSource(snapshot, target);
      if (!source) throw new Error('저장된 해설을 찾을 수 없습니다. 논문을 다시 열어주세요.');
      const manifest = await store.readManifest(sha);
      const rev = manifest.currentExtractionRevision;
      if (!rev) throw new Error('논문 분석 결과가 없습니다.');
      const document = await store.readJson(
        'extractionDocument',
        store.extractionPath(sha, rev, 'document.json'),
      );
      const sentences =
        target.kind === 'section'
          ? document.sentences.filter(
              (s, i, all) =>
                s.id === target.sentenceId ||
                all[i - 1]?.id === target.sentenceId ||
                all[i + 1]?.id === target.sentenceId,
            )
          : document.sentences
              .filter((s) => snapshot.results[s.id]?.conceptIds?.includes(target.conceptId))
              .slice(0, 4);
      return {
        source,
        context: {
          title: document.paper.title ?? document.paper.fileName,
          summary: snapshot.overview?.summary ?? '',
          sentences: sentences.map((s) => ({ id: s.id, en: s.en })),
        },
      };
    },
    (state) => {
      for (const win of BrowserWindow.getAllWindows())
        if (!win.isDestroyed()) win.webContents.send(IPC.additionalEvent, state);
    },
  );
  const registeredSha = (sha: unknown): string => {
    if (typeof sha !== 'string' || !registry.isRegistered(sha))
      throw new Error('등록되지 않은 PDF');
    return sha;
  };
  ipcMain.handle(IPC.additionalRead, (_event, sha: unknown) => {
    const id = registeredSha(sha);
    return runPaperTask(id, () => additionalExplanations.read(id));
  });
  ipcMain.handle(IPC.additionalRequest, (_event, sha: unknown, value: unknown) => {
    const id = registeredSha(sha);
    const target = parseAdditionalTarget(value);
    return runPaperTask(id, () => additionalExplanations.request(id, target));
  });
  ipcMain.handle(IPC.paperDeleteData, async (event, sha: unknown) => {
    if (typeof sha !== 'string' || !registry.isRegistered(sha))
      throw new Error('등록되지 않은 PDF');
    const fileName = basename(registry.originalPathOf(sha));
    const deleted = await paperDeletion.remove(sha, async () => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) throw new Error('삭제를 확인할 창이 없습니다.');
      const answer = await dialog.showMessageBox(win, {
        type: 'warning',
        title: '논문 데이터 삭제',
        message: `“${fileName}”의 저장 데이터를 삭제할까요?`,
        detail:
          '이 논문의 분석 결과, 번역·해설과 추가 AI 설명, 논문 노트와 추천 자료가 삭제됩니다. 되돌릴 수 없으며, 다시 읽으려면 분석·번역을 다시 진행해야 합니다.\n\nPDF 원본과 책갈피, 다른 논문의 데이터는 유지됩니다.',
        buttons: ['취소', '삭제'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return answer.response === 1;
    });
    if (deleted) {
      if (autoResume?.status.kind !== 'none' && autoResume?.status.pdfSha256 === sha)
        autoResume.cancel();
      workProgress.forget(sha);
      preparation.forget(sha);
      additionalExplanations.forget(sha);
      for (const key of extractedPages.keys())
        if (key.startsWith(`${sha}:`)) extractedPages.delete(key);
      registry.forget(sha);
    }
    return { deleted };
  });
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

  ipcMain.handle(IPC.libraryList, () => listLibrary(store, scheduler?.runningPaper ?? null));
  ipcMain.handle(IPC.libraryOpen, async (_event, sha: unknown) => {
    if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha))
      throw new Error('잘못된 논문 ID입니다.');
    const paper = (await listLibrary(store, scheduler?.runningPaper ?? null)).find(
      (p) => p.pdfSha256 === sha,
    );
    if (!paper?.available || !paper.originalPath)
      throw new Error('PDF 원본을 찾을 수 없습니다. PDF 열기에서 파일을 다시 선택해 주세요.');
    if ((await sha256File(paper.originalPath)) !== sha)
      throw new Error('PDF 원본이 다른 파일로 바뀌었습니다. PDF 열기에서 다시 선택해 주세요.');
    return registry.register(paper.originalPath);
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
      return runPaperTask(parsed.pdfSha256, async () => {
        const result = await saveTextItems(store, parsed, {
          parserConfigHash: grobid.parserConfigHash(FULLTEXT_PARAMS),
        });
        if (!result.halted) {
          extractedPages.set(`${parsed.pdfSha256}:${result.extractionRevision}`, result.pages);
        }
        return result;
      });
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
      return runPaperTask(pdfSha256, async () => {
        const manifest = await store.readManifest(pdfSha256);
        const rev = manifest.currentExtractionRevision;
        if (!rev) throw new Error(`추출 revision이 없습니다 (state=${manifest.state})`);
        const bytes = await registry.readBytes(pdfSha256);
        if (setupAgent.read().busy)
          throw new Error('읽기 환경 자동 해결이 끝난 뒤 PDF를 다시 열어주세요.');
        parsingPapers++;
        const result = await processFulltext(grobid, bytes).finally(() => {
          parsingPapers--;
        });
        const teiPath = await saveOriginalTei(store, pdfSha256, rev, result.tei);
        return {
          teiPath,
          byteLength: Buffer.byteLength(result.tei),
          hasSentenceCoords: result.hasSentenceCoords,
          parserConfigHash: result.parserConfigHash,
          elapsedMs: result.elapsedMs,
        };
      });
    },
  );

  // TEI(C1.7)와 source-map(C1.5)을 합쳐 document.json을 확정하고 manifest를 mapping으로 옮긴다(C1.14).
  ipcMain.handle(
    IPC.extractBuildDocument,
    async (_event, pdfSha256: unknown): Promise<MappingResult> => {
      if (typeof pdfSha256 !== 'string' || !registry.isRegistered(pdfSha256)) {
        throw new Error('등록되지 않은 PDF');
      }
      return runPaperTask(pdfSha256, async () => {
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
      });
    },
  );

  // 확정된 document.json의 문장 색인을 renderer에 보낸다(C1.15 선택 해석·C1.16 표시용).
  ipcMain.handle(
    IPC.extractReadDocument,
    async (_event, pdfSha256: unknown): Promise<ReadDocumentResult> => {
      if (typeof pdfSha256 !== 'string' || !registry.isRegistered(pdfSha256)) {
        throw new Error('등록되지 않은 PDF');
      }
      return runPaperTask(pdfSha256, async () => {
        const index = await readSentenceIndex(store, pdfSha256);
        // 개발·E2E용: PAPERLENS_AUTO_PROCESS=1이면 문장 색인을 읽은 직후 번역 처리를 시작한다(한도를 쓴다).
        if (process.env['PAPERLENS_AUTO_PROCESS']) {
          const started = startProcessing(pdfSha256, 'PAPERLENS_AUTO_PROCESS');
          if (!started.started) console.log(`[process] 시작하지 않음: ${String(started.reason)}`);
        }
        return index;
      });
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
  preparation = new PreparationService(
    store,
    jobs,
    (value) => publishWork({ type: 'preparation', preparation: value }),
    researchEnabled,
  );
  const assertRegistered = (sha: unknown): string => {
    if (typeof sha !== 'string' || !registry.isRegistered(sha))
      throw new Error('등록되지 않은 PDF');
    return sha;
  };
  ipcMain.handle(IPC.workRead, async (_event, sha: unknown): Promise<ReadingWork> => {
    const id = assertRegistered(sha);
    return { progress: workProgress.read(id), preparation: await preparation.read(id) };
  });
  ipcMain.handle(IPC.preparationRefresh, async (_event, sha: unknown): Promise<void> => {
    const id = assertRegistered(sha);
    return runPaperTask(id, async () => {
      const manifest = await store.readManifest(id);
      const rev = manifest.currentExtractionRevision;
      if (!rev) throw new Error('먼저 논문의 문장 분석을 완료해 주세요.');
      const doc = await store.readJson(
        'extractionDocument',
        store.extractionPath(id, rev, 'document.json'),
      );
      void preparation.start(doc, true);
    });
  });
  scheduler = new PaperScheduler({
    store,
    onDocument: (document) => {
      void preparation.start(document);
    },
    // 네트워크·서버 오류는 5·15·45초 뒤 다시 보낸다(C5.3). 멈춤 요청이 오면 기다리지 않는다.
    runner: workProgress.wrap(
      new RetryingJobRunner({
        inner: jobs,
        onRetry: (id, attempt, delay) =>
          workProgress.retry(scheduler?.runningPaper ?? null, id, attempt, delay),
        shouldContinue: () => !stopRequested,
        log: (line) => console.log(`[process] ${line}`),
      }),
      () => scheduler?.runningPaper ?? null,
    ),
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
    workProgress.handle(event);
    notifyCompletion(event);
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

  // 점검은 읽기 전용이다. 다운로드·설치는 별도의 준비 흐름에서 처리한다.
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
  ipcMain.handle(IPC.depsStartGrobid, (): Promise<StartGrobidResult> =>
    setupAgent.read().busy
      ? Promise.resolve({
          started: false,
          message: '읽기 환경 자동 해결이 끝난 뒤 PDF를 다시 열어주세요.',
        })
      : localSetup.startExisting(),
  );
  ipcMain.handle(IPC.setupRead, () => localSetup.setup.read());
  ipcMain.handle(IPC.setupAction, async (_event, action: unknown) => {
    if (typeof action !== 'string' || !SETUP_ACTIONS.includes(action as SetupAction))
      throw new Error('알 수 없는 준비 동작입니다.');
    if (setupAgent.read().busy) {
      if (action !== 'cancel')
        throw new Error('자동 해결이 진행 중입니다. 먼저 중단한 뒤 직접 조작해주세요.');
      await setupAgent.cancel();
    }
    return localSetup.action(action as SetupAction);
  });
  ipcMain.handle(IPC.setupHelp, async (_event, question: unknown) => {
    if (account.lastStatus.state !== 'authenticated')
      throw new Error(
        '계정 메뉴에서 ChatGPT 로그인 후 다시 눌러주세요. 기본 설치 안내와 자동 준비는 로그인 없이 이용할 수 있습니다.',
      );
    return setupAssistant.ask(
      localSetup.setup.read(),
      question,
      await localSetup.diagnose(AbortSignal.timeout(45_000)),
    );
  });

  ipcMain.handle(IPC.setupAgentRead, () => setupAgent.read());
  ipcMain.handle(IPC.setupAgentStart, (_event, question: unknown, consent: unknown) => {
    if (account.lastStatus.state !== 'authenticated')
      throw new Error(
        'ChatGPT 로그인 후 다시 맡겨주세요. 기본 자동 준비는 로그인 없이도 이용할 수 있습니다.',
      );
    return setupAgent.start(question, consent);
  });
  ipcMain.handle(IPC.setupAgentCancel, async () => {
    await setupAgent.cancel();
    return setupAgent.read();
  });

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
    // 조사 런타임이 없어도 번역은 된다. 개념 카드의 뜻은 검색 없이 쓴 일반 설명이 된다.
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
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  void Promise.all([
    setupAgent?.cancel(true).then(() => localSetup?.close()) ?? localSetup?.close(),
    ...live.map((r) =>
      r.stop().catch((err: unknown) => console.error(`[codex] 종료 실패: ${String(err)}`)),
    ),
  ]).finally(() => app.quit());
});

void app.whenReady().then(async () => {
  store = new PaperCacheStore(join(app.getPath('userData'), 'cache'));
  registry = new PdfRegistry(store);
  grobid = new GrobidClient();
  localSetup = await createLocalSetup(
    async () => (await grobid.isAlive()).ok,
    (state) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC.setupEvent, state);
      }
    },
    () => parsingPapers === 0,
  );
  setupAgent = new SetupAgent(jobs, {
    diagnose: (signal) => localSetup.diagnose(signal),
    execute: (action, signal) => localSetup.executeRepair(action, signal),
    waitForSetup: (signal) => localSetup.waitForSetup(signal),
    cancel: async (preserveAutomaticStart) => {
      if (preserveAutomaticStart) {
        localSetup.setup.abort();
        await localSetup.setup.settled();
      } else await localSetup.setup.cancel();
    },
    publish: (state) => {
      if (state.phase === 'ready') localSetup.setup.confirmReady();
      for (const win of BrowserWindow.getAllWindows())
        if (!win.isDestroyed()) win.webContents.send(IPC.setupAgentEvent, state);
    },
  });
  registerIpc();
  createWindow();
  if (!process.env['PAPERLENS_NO_SETUP_AUTOSTART'])
    void localSetup.resume().catch((error: unknown) => console.error('[setup]', error));
  void bootCodex();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
