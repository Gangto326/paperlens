import type { FontRecord, Page, TextItemRecord, TextQuality } from './schema';
import type { SentenceIndex } from './mapping/selection';

export type { SentenceIndex, SentenceIndexEntry } from './mapping/selection';

/**
 * renderer ↔ main 사이의 제한된 IPC 계약.
 * 채널 이름과 요청/응답 타입을 한곳에서 정의한다. preload는 이 목록에 있는 채널만 노출한다.
 */
export const IPC = {
  appInfo: 'app:info',
  pdfOpenDialog: 'pdf:openDialog',
  pdfReadBytes: 'pdf:readBytes',
  extractSaveTextItems: 'extract:saveTextItems',
  parserHealth: 'parser:health',
  parserFulltext: 'parser:fulltext',
  extractBuildDocument: 'extract:buildDocument',
  extractReadDocument: 'extract:readDocument',
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
  /** 항목 fontName → 실제 글꼴 이름. 문서에 나온 글꼴마다 하나. */
  fonts: FontRecord[];
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

/** GROBID 서비스 상태. 실패 시 guidance에 사용자가 할 일(Docker 실행 명령)을 담는다. */
export type ParserHealth =
  | { ok: true; version: string | null }
  | {
      ok: false;
      reason: 'unreachable' | 'timeout' | 'unhealthy';
      message: string;
      guidance: string;
    };

/** GROBID processFulltextDocument 결과. TEI 본문은 파일에만 두고 renderer에는 요약만 보낸다. */
export interface ParserFulltextResult {
  teiPath: string;
  byteLength: number;
  hasSentenceCoords: boolean;
  parserConfigHash: string;
  elapsedMs: number;
}

/** document.json 확정 결과(C1.14). 문장 본문은 파일에만 두고 renderer에는 집계만 보낸다. */
export interface MappingResult {
  extractionRevision: string;
  documentPath: string;
  sentenceCount: number;
  mapped: number;
  uncertain: number;
  unmapped: number;
  /** 인라인 수식 자리표시자 수(detected + math_uncertain) */
  equationCount: number;
  readingOrderMismatches: number;
  /** 문서 수준 경고(document.json의 warnings와 같다) */
  warnings: string[];
  elapsedMs: number;
}

/**
 * document.json에서 renderer가 선택 해석·표시에 쓰는 부분만 뽑은 색인(C1.15). 문장 본문(en)·스팬·사각형은 포함하고
 * TEI 원문·정규화 대응표·서지는 포함하지 않는다. 문장 수백 개·스팬 수천 개라도 수백 KB 수준이라 한 번에 보낸다.
 */
export type ReadDocumentResult = SentenceIndex & { documentPath: string };
