import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type AppInfo,
  type MappingResult,
  type ParserFulltextResult,
  type ParserHealth,
  type PdfOpenDialogResult,
  type TextExtractionPayload,
  type TextExtractionResult,
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
};

export type PaperLensApi = typeof api;

contextBridge.exposeInMainWorld('paperlens', api);
