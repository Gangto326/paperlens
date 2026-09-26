import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type AppInfo } from '@shared/ipc';

/** renderer에 노출하는 유일한 API. 채널을 직접 노출하지 않고 함수 단위로 감싼다. */
const api = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appInfo),
};

export type PaperLensApi = typeof api;

contextBridge.exposeInMainWorld('paperlens', api);
