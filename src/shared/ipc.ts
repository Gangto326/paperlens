import type {
  FontRecord,
  Page,
  PaperState,
  SentenceExplanation,
  TextItemRecord,
  TextQuality,
} from './schema';
import type { SentenceIndex } from './mapping/selection';

export type { SentenceIndex, SentenceIndexEntry } from './mapping/selection';

/**
 * renderer ↔ main 사이의 제한된 IPC 계약.
 * 채널 이름과 요청/응답 타입을 한곳에서 정의한다. preload는 이 목록에 있는 채널만 노출한다.
 */
export const IPC = {
  appInfo: 'app:info',
  workRead: 'work:read',
  workEvent: 'work:event',
  preparationRefresh: 'work:preparation',
  openCompletedPaper: 'work:openCompleted',
  pdfOpenDialog: 'pdf:openDialog',
  libraryList: 'library:list',
  libraryOpen: 'library:open',
  pdfReadBytes: 'pdf:readBytes',
  paperDeleteData: 'paper:deleteData',
  additionalRead: 'additional:read',
  additionalRequest: 'additional:request',
  additionalEvent: 'additional:event',
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
  translateReadResults: 'translate:readResults',
  processStart: 'process:start',
  processStop: 'process:stop',
  /** main → renderer 푸시(처리 단계·진행). */
  processEvent: 'process:event',
  /** 의존 서비스 점검(C5.1). */
  depsCheck: 'deps:check',
  depsStartGrobid: 'deps:startGrobid',
  setupRead: 'setup:read',
  setupAction: 'setup:action',
  setupEvent: 'setup:event',
  setupHelp: 'setup:help',
  setupAgentRead: 'setup:agentRead',
  setupAgentStart: 'setup:agentStart',
  setupAgentCancel: 'setup:agentCancel',
  setupAgentEvent: 'setup:agentEvent',
} as const;

/** 시작 시 의존 서비스 점검 결과(C5.1). 준비가 필요한 항목은 앱 내 설치 안내로 연결한다. */
export interface DependencyReport {
  docker: {
    ok: boolean;
    reason: 'ok' | 'not_installed' | 'not_running' | 'error';
    message: string;
    imagePresent: boolean | null;
    containerRunning: boolean | null;
  };
  grobid: ParserHealth;
  codex: {
    /** 앱이 띄운 Codex App Server가 돌고 있는지 */
    runtime: 'running' | 'stopped' | 'disabled';
    account: LlmAccountStatus;
  };
  checkedAt: string;
}

export interface StartGrobidResult {
  started: boolean;
  message: string;
}

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

export interface LibraryPaper {
  pdfSha256: string;
  title: string;
  fileName: string;
  originalPath: string | null;
  available: boolean;
  state: PaperState;
  running: boolean;
  updatedAt: string;
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

/** GROBID 서비스 상태. 실패 시 guidance에 사용자가 할 일(앱 내 준비 안내)을 담는다. */
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

/**
 * 번역 처리 시작 결과(C2.8). 처리는 main에서 백그라운드로 돌고 진행은 process:event로 푸시된다.
 * started가 false면 reason에 이유가 있다(다른 논문 처리 중, LLM 런타임 없음 등).
 */
export interface ProcessStart {
  started: boolean;
  reason: string | null;
}

/** 멈춤 요청 결과. 돌고 있는 청크가 끝난 뒤 멈춘다. 돌고 있는 처리가 없으면 accepted가 false다. */
export interface ProcessStop {
  accepted: boolean;
}

export type ProcessStopReason =
  | 'complete'
  | 'complete_with_gaps'
  | 'paused'
  | 'needs_login'
  | 'waiting_quota'
  | 'too_many_failures'
  | 'context_failed'
  | 'invalid_state'
  | 'no_document'
  | 'busy';

/** main이 renderer에 푸시하는 처리 진행 이벤트. 진행률은 실제로 끝난 청크 수다(PLAN 9절). */
export type ProcessEvent =
  | { type: 'state'; pdfSha256: string; state: PaperState }
  | {
      type: 'context';
      pdfSha256: string;
      status: 'running' | 'reused' | 'done' | 'failed';
      message: string | null;
      /** 긴 논문의 부분 작업 진행. 끝난 부분 수와 전체 부분 수(C3.6). 한 번에 읽는 논문에는 없다 */
      progress?: { done: number; total: number };
    }
  | {
      /** 개념 카드 조사 단계. researched는 읽은 자료가 붙은 카드 수, sources는 저장한 출처 수다. */
      type: 'research';
      pdfSha256: string;
      status: 'running' | 'done' | 'skipped' | 'stopped';
      researched: number;
      sources: number;
      message: string | null;
      /** 끝난 묶음 수와 전체 묶음 수(C3.6) */
      progress?: { done: number; total: number };
    }
  | { type: 'plan'; pdfSha256: string; total: number }
  | { type: 'chunkStarted'; pdfSha256: string; chunkId: string; total: number }
  | {
      type: 'chunkFinished';
      pdfSha256: string;
      chunkId: string;
      ok: boolean;
      completed: number;
      failed: number;
      total: number;
      /** 이 청크에서 결과가 확정된 문장 */
      sentenceIds: string[];
    }
  | {
      type: 'finished';
      pdfSha256: string;
      reason: ProcessStopReason;
      message: string | null;
      state: PaperState;
      completed: number;
      failed: number;
      total: number;
    }
  /**
   * 자동 재개 대기(C3.5). quota는 한도가 풀리기를 기다린다. resumeAt은 다음에 한도를 확인할 시각(ISO 8601)이고
   * 갱신 시각을 모르면 null이다. login은 로그인이 끝나기를 기다린다. none은 기다림이 끝난 것이다.
   */
  | {
      type: 'waiting';
      pdfSha256: string | null;
      kind: 'none' | 'quota' | 'login';
      resumeAt: string | null;
    };

/** 문장 하나의 저장된 번역·해설(C2.9). 검증을 통과해 완료된 청크의 결과만 온다. */
export interface SentenceTranslation {
  ko: string;
  /** 칸으로 나누기 전 세대의 해설. 없으면 빈 문자열. 화면에서는 숨긴다. */
  note: string;
  /** 해설 칸. 칸으로 나누기 전 세대에는 없다. */
  explanation?: SentenceExplanation | null;
  /** 이 문장에 이어진 개념 카드 id. `TranslationSnapshot.concepts`의 키다. */
  conceptIds?: string[];
  warnings: string[];
  chunkId: string;
  /** 앞선 세대의 결과를 대신 보여 주는 것이면 그 세대의 id */
  previousGenerationId?: string;
}

/** 개념 카드에 붙는 자료 링크. 주소는 조사 턴의 검색 기록과 대조해 통과한 것이다. */
export interface ConceptSourceLink {
  sourceId: string;
  url: string;
  title: string;
  /** 자료가 있는 곳. 예: www.elastic.co */
  publisher: string | null;
  /** article · paper · docs · video */
  kind: string;
  language: string | null;
  /** 이 자료가 뒷받침하는 내용 */
  supports: string;
}

/** 논문 개요와 용어집(C3.7). 지금 세대의 context.json에서 읽는다. 1차 패스가 끝나는 즉시 보인다. */
export interface PaperOverview {
  summary: string;
  researchQuestion: string;
  contributions: string[];
  methodOverview: string;
  mainResults: string[];
  limitations: string[];
  unresolved: string[];
  glossary: {
    term: string;
    aliases: string[];
    preferredKo: string;
    acceptedKo: string[];
    meaningInPaper: string;
  }[];
}

/** 화면에 보이는 개념 카드. */
export interface ConceptCard {
  id: string;
  name: string;
  nameKo: string | null;
  definitionKo: string;
  whyItMatters: string;
  exampleKo: string | null;
  prerequisiteConceptIds: string[];
  /** 읽고 확인한 출처가 있는 설명이면 true. 아니면 "일반 설명, 출처 미확인"으로 표시한다. */
  sourced: boolean;
  /** 읽은 자료. 조사 턴에 열람 기록이 있다. */
  sources?: ConceptSourceLink[];
  /** 더 볼 자료. 검색 결과에 나왔지만 앱이 내용을 확인하지 못했다. */
  further?: ConceptSourceLink[];
}

/** 캐시에 저장된 번역 상태 전체. 선택 시 표시는 이 값을 메모리에서 조회한다. */
export interface TranslationSnapshot {
  pdfSha256: string;
  state: PaperState;
  generationId: string | null;
  /**
   * 읽기 순서의 청크. pending은 아직 결과 파일이 없는 청크다.
   * `previous`는 지금 세대에는 아직 없고 앞선 세대의 완료 결과를 대신 보여 주는 청크다(COMMIT_PLAN C3.2).
   * 진행률에는 지금 세대의 완료만 센다.
   */
  chunks: {
    id: string;
    status: 'pending' | 'complete' | 'failed';
    sentenceIds: string[];
    previous?: boolean;
  }[];
  /** 문장 ID → 번역. 완료된 문장만 들어 있다. 앞선 세대의 것은 `previousGenerationId`가 있다. */
  results: Record<string, SentenceTranslation>;
  /** 개념 카드 id → 카드. 컨텍스트를 읽지 못했거나 카드가 없는 세대는 비어 있다. */
  concepts?: Record<string, ConceptCard>;
  /** 논문 개요와 용어집. 컨텍스트가 아직 없으면 null */
  overview?: PaperOverview | null;
}
