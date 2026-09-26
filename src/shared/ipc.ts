import type { Page, TextItemRecord, TextQuality } from './schema';

/**
 * renderer ↔ main 사이의 제한된 IPC 계약.
 * 채널 이름과 요청/응답 타입을 한곳에서 정의한다. preload는 이 목록에 있는 채널만 노출한다.
 */
export const IPC = {
  appInfo: 'app:info',
  pdfOpenDialog: 'pdf:openDialog',
  pdfReadBytes: 'pdf:readBytes',
  extractSaveTextItems: 'extract:saveTextItems',
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

/** renderer가 PDF.js로 전 페이지 텍스트 항목을 모아 메인에 저장을 요청할 때 보내는 값. */
export interface TextExtractionPayload {
  pdfSha256: string;
  pdfjsVersion: string;
  /** renderer 추출 규칙(ID·index 부여) 버전. 바뀌면 extraction revision이 바뀐다. */
  textExtractorVersion: string;
  /** textQuality는 메인이 판정해 채운다. renderer는 'ok'로 보낸다. */
  pages: Page[];
  textItems: TextItemRecord[];
}

/** 메인이 source-map.json을 쓰고 품질을 판정한 결과. */
export interface TextExtractionResult {
  extractionRevision: string;
  sourceMapPath: string;
  itemCount: number;
  /** textQuality가 채워진 페이지 정보 (document.json 확정은 C1.14) */
  pages: Page[];
  textQuality: TextQuality;
  /** needs_ocr·garbled이면 true. manifest.state는 failed, 이후 단계는 진행하지 않는다. */
  halted: boolean;
}
