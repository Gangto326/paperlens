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
  llmAccountRead: 'llm:accountRead',
  llmLoginStart: 'llm:loginStart',
  llmLoginCancel: 'llm:loginCancel',
  llmLogout: 'llm:logout',
  llmRateLimitsRead: 'llm:rateLimitsRead',
  /** main → renderer 푸시(계정·한도·로그인 완료). 나머지는 renderer → main invoke. */
  llmAccountEvent: 'llm:accountEvent',
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

/**
 * LLM 계정 상태(C1.19, PLAN 4.2 "인증 상태 확인·로그인"). Codex 고유 응답은 어댑터(main/llm/codex) 밖으로 내보내지 않고
 * 앱이 정의한 이 형태로만 renderer에 준다.
 * - unavailable: 런타임이 뜨지 않았거나 응답할 수 없다(PAPERLENS_NO_CODEX, 시작 실패, 종료).
 * - needs_login: 런타임은 있으나 로그인된 계정이 없다(PaperState `needs_login`과 같은 뜻).
 */
export type LlmAccountStatus =
  | { state: 'unavailable'; reason: string }
  | { state: 'needs_login' }
  | {
      state: 'authenticated';
      method: 'chatgpt' | 'api_key' | 'other';
      email: string | null;
      /** 계정이 보고한 요금제 이름(예: plus, pro). 앱은 특정 요금제를 가정하지 않는다. */
      plan: string | null;
    };

/** 한도 창 하나. resetsAt은 ISO 8601(UTC). 값이 없으면 null이고 UI는 "확인 불가"로 표시한다. */
export interface LlmRateLimitWindow {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: string | null;
}

/** 사용 한도(PLAN 10: 계정이 제공하는 한도·갱신 시각 또는 unavailable). */
export type LlmRateLimits =
  | {
      available: true;
      primary: LlmRateLimitWindow | null;
      secondary: LlmRateLimitWindow | null;
      plan: string | null;
      /** 조회 또는 알림 수신 시각(ISO 8601) */
      readAt: string;
    }
  | { available: false; reason: 'needs_login' | 'unavailable' | 'error'; message: string };

/** 로그인 흐름 시작 결과. started면 main이 authUrl을 기본 브라우저로 열었다. */
export type LlmLoginStart =
  { started: true; loginId: string; authUrl: string } | { started: false; reason: string };

export type LlmLoginCancel = 'canceled' | 'not_found' | 'unavailable';

export interface LlmLoginCompleted {
  loginId: string | null;
  success: boolean;
  error: string | null;
}

/** main이 renderer에 푸시하는 계정 관련 이벤트. */
export type LlmAccountEvent =
  | { type: 'account'; status: LlmAccountStatus }
  | { type: 'rateLimits'; rateLimits: LlmRateLimits }
  | { type: 'loginCompleted'; result: LlmLoginCompleted };
