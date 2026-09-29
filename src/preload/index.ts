import { contextBridge, ipcRenderer } from 'electron';
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
  type ProcessEvent,
  type ProcessStart,
  type ProcessStop,
  type ReadDocumentResult,
  type TextExtractionPayload,
  type TextExtractionResult,
  type TranslationSnapshot,
} from '@shared/ipc';

/** renderer에 노출하는 유일한 API. 채널을 직접 노출하지 않고 함수 단위로 감싼다. */
const api = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appInfo),
  openPdfDialog: (): Promise<PdfOpenDialogResult> => ipcRenderer.invoke(IPC.pdfOpenDialog),
  readPdfBytes: (pdfSha256: string): Promise<Uint8Array> =>
    ipcRenderer.invoke(IPC.pdfReadBytes, pdfSha256),
  saveTextItems: (payload: TextExtractionPayload): Promise<TextExtractionResult> =>
    ipcRenderer.invoke(IPC.extractSaveTextItems, payload),
  checkParser: (): Promise<ParserHealth> => ipcRenderer.invoke(IPC.parserHealth),
  runParser: (pdfSha256: string): Promise<ParserFulltextResult> =>
    ipcRenderer.invoke(IPC.parserFulltext, pdfSha256),
  buildDocument: (pdfSha256: string): Promise<MappingResult> =>
    ipcRenderer.invoke(IPC.extractBuildDocument, pdfSha256),
  readDocument: (pdfSha256: string): Promise<ReadDocumentResult> =>
    ipcRenderer.invoke(IPC.extractReadDocument, pdfSha256),
  readAccount: (): Promise<LlmAccountStatus> => ipcRenderer.invoke(IPC.llmAccountRead),
  startLogin: (): Promise<LlmLoginStart> => ipcRenderer.invoke(IPC.llmLoginStart),
  cancelLogin: (loginId: string): Promise<LlmLoginCancel> =>
    ipcRenderer.invoke(IPC.llmLoginCancel, loginId),
  logout: (): Promise<LlmAccountStatus> => ipcRenderer.invoke(IPC.llmLogout),
  readRateLimits: (): Promise<LlmRateLimits> => ipcRenderer.invoke(IPC.llmRateLimitsRead),
  /** main이 푸시하는 계정·한도·로그인 완료 이벤트 구독. 반환값은 구독 해제 함수. */
  onAccountEvent: (handler: (event: LlmAccountEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: LlmAccountEvent): void =>
      handler(payload);
    ipcRenderer.on(IPC.llmAccountEvent, listener);
    return () => ipcRenderer.removeListener(IPC.llmAccountEvent, listener);
  },
  /** 저장된 번역 결과(C2.9). 캐시 파일만 읽는다. */
  readTranslations: (pdfSha256: string): Promise<TranslationSnapshot> =>
    ipcRenderer.invoke(IPC.translateReadResults, pdfSha256),
  /** 번역 처리 시작(C2.8). 컨텍스트 → 청크 순서로 main에서 돈다. */
  startProcessing: (pdfSha256: string): Promise<ProcessStart> =>
    ipcRenderer.invoke(IPC.processStart, pdfSha256),
  stopProcessing: (): Promise<ProcessStop> => ipcRenderer.invoke(IPC.processStop),
  onProcessEvent: (handler: (event: ProcessEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ProcessEvent): void =>
      handler(payload);
    ipcRenderer.on(IPC.processEvent, listener);
    return () => ipcRenderer.removeListener(IPC.processEvent, listener);
  },
};

export type PaperLensApi = typeof api;

contextBridge.exposeInMainWorld('paperlens', api);
