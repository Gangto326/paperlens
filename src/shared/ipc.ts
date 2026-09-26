/**
 * renderer ↔ main 사이의 제한된 IPC 계약.
 * 채널 이름과 요청/응답 타입을 한곳에서 정의한다. preload는 이 목록에 있는 채널만 노출한다.
 */
export const IPC = {
  appInfo: 'app:info',
  pdfOpenDialog: 'pdf:openDialog',
  pdfReadBytes: 'pdf:readBytes',
} as const;

export interface AppInfo {
  appVersion: string;
  electronVersion: string;
  platform: string;
  userDataPath: string;
  /** PAPERLENS_OPEN_PDF 환경변수로 시작 시 자동 등록된 PDF (개발·E2E용) */
  autoOpened?: OpenedPdf | null;
  /** PAPERLENS_SCREENSHOT이 설정돼 창 캡처가 예정된 상태. renderer는 이때만 검증용 선택 등 디버그 동작을 한다. */
  screenshotMode: boolean;
}

/** 파일 선택 후 메인이 해시·등록을 마치고 돌려주는 정보. 바이트는 별도 요청으로 받는다. */
export interface OpenedPdf {
  pdfSha256: string;
  fileName: string;
  originalPath: string;
  byteLength: number;
}

export type PdfOpenDialogResult = { canceled: true } | ({ canceled: false } & OpenedPdf);
