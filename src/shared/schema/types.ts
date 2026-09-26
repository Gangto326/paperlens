/**
 * 캐시 스키마 v1 (PLAN.md 8.2). 파일 단위로 나뉜 논리적 PaperCache.
 *
 * 규칙:
 * - 모든 프로그램 인덱스는 0부터, 사용자에게 보이는 페이지 번호(pdfPageNumber)는 1부터.
 * - 추출 결과(Sentence 등)는 extraction revision에 귀속하고 LLM 출력으로 덮어쓰지 않는다.
 * - 번역 결과(SentenceResult)는 generation에 귀속한다. 두 객체는 파일도 타입도 분리한다.
 * - 날짜는 ISO 8601 문자열. 좌표는 Rect.coordinateSpace가 단위·원점을 명시한다.
 */

export const SCHEMA_VERSION = 1 as const;

// ───────────────────────── 공통 enum ─────────────────────────

export type PaperState =
  | 'imported'
  | 'extracting'
  | 'mapping'
  | 'context_pending'
  | 'researching'
  | 'translating'
  | 'paused'
  | 'waiting_quota'
  | 'needs_login'
  | 'complete'
  | 'complete_with_gaps'
  | 'failed';

export type WorkStatus =
  | 'pending'
  | 'running'
  | 'needs_research'
  | 'waiting_retry'
  | 'waiting_quota'
  | 'complete'
  | 'complete_with_gaps'
  | 'failed';

export type SentenceStatus = 'pending' | 'complete' | 'needs_review' | 'failed';
export type MappingStatus = 'mapped' | 'uncertain' | 'unmapped';
export type FetchStatus = 'read' | 'partial' | 'failed';
export type SentenceKind = 'sentence' | 'fragment';
export type TextQuality = 'ok' | 'sparse' | 'garbled' | 'needs_ocr';
export type CoordinateSpace = 'grobid_top_left_pdf_units' | 'pdf_user_space';
export type ExcludedBlockType =
  | 'figure'
  | 'table'
  | 'caption'
  | 'formula'
  | 'footnote'
  | 'bibliography'
  | 'header'
  | 'footer'
  | 'page_number'
  | 'other';
export type EquationDetectionStatus = 'detected' | 'math_uncertain';
export type ReservationState = 'reserved' | 'sent' | 'succeeded' | 'failed' | 'unknown';
export type ResearchStatus = 'researched' | 'unresolved' | 'not_needed';
export type DiscoveredBy = 'search' | 'bibliography';

// ───────────────────────── 추출 (extraction/<revision>) ─────────────────────────

export interface Paper {
  id: string;
  pdfSha256: string;
  fileName: string;
  originalPath?: string | null;
  title?: string | null;
  authors: string[];
  year?: number | null;
  doi?: string | null;
  pageCount: number;
  importedAt: string;
}

export interface Pipeline {
  extractionRevision: string;
  parserName: string;
  parserVersion: string;
  parserConfigHash: string;
  pdfjsVersion: string;
  normalizerVersion: string;
  segmenterVersion: string;
}

export interface Rect {
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  coordinateSpace: CoordinateSpace;
  transformVersion: string;
}

export interface Page {
  pageIndex: number;
  pdfPageNumber: number;
  width: number;
  height: number;
  rotation: number;
  mediaBox: [number, number, number, number];
  cropBox: [number, number, number, number];
  coordinateSpace: CoordinateSpace;
  textQuality: TextQuality;
  warnings: string[];
}

export interface Section {
  id: string;
  parentId?: string | null;
  title: string;
  order: number;
  sentenceIds: string[];
}

export interface SourceSpan {
  pageIndex: number;
  textItemId: string;
  utf16Start: number;
  utf16End: number;
  normalizedStart: number;
  normalizedEnd: number;
  normalizationMapId: string;
}

export interface EquationPlaceholder {
  id: string;
  token: string;
  rawText?: string | null;
  sourceSpans: SourceSpan[];
  rects: Rect[];
  detectionStatus: EquationDetectionStatus;
  warning?: string | null;
}

/** 추출 불변 문장. 번역 결과는 SentenceResult에 따로 둔다. */
export interface Sentence {
  id: string;
  order: number;
  page: number;
  pages: number[];
  sectionId: string;
  paragraphId: string;
  kind: SentenceKind;
  enRaw: string;
  en: string;
  sourceSpans: SourceSpan[];
  rects: Rect[];
  mappingStatus: MappingStatus;
  mappingConfidence?: number | null;
  equations: EquationPlaceholder[];
  citationMarkers: string[];
  warnings: string[];
}

export interface ExcludedBlock {
  id: string;
  type: ExcludedBlockType;
  pageIndices: number[];
  rects: Rect[];
  rawText?: string | null;
  reason: string;
  confidence?: number | null;
}

export interface BibliographicItem {
  id: string;
  rawText: string;
  title?: string | null;
  authors: string[];
  year?: number | null;
  doi?: string | null;
  urlFromPdf?: string | null;
  citingSentenceIds: string[];
}

/** extraction/<revision>/document.json */
export interface ExtractionDocument {
  schemaVersion: typeof SCHEMA_VERSION;
  paper: Paper;
  pipeline: Pipeline;
  pages: Page[];
  sections: Section[];
  sentences: Sentence[];
  excludedBlocks: ExcludedBlock[];
  bibliography: BibliographicItem[];
  warnings: string[];
}

/** PDF.js getTextContent 항목 하나. 원본 그대로 보존한다. */
export interface TextItemRecord {
  id: string;
  pageIndex: number;
  index: number;
  str: string;
  transform: [number, number, number, number, number, number];
  width: number;
  height: number;
  fontName: string;
  dir: string;
  hasEOL: boolean;
}

/** 정규화 대응표: 원본 offset 구간 ↔ 정규화 offset 구간 (둘 다 UTF-16). */
export interface NormalizationSegment {
  rawStart: number;
  rawEnd: number;
  normStart: number;
  normEnd: number;
  kind: 'copy' | 'ligature' | 'space' | 'hyphen' | 'drop' | 'insert';
}

export interface NormalizationMap {
  id: string;
  version: string;
  segments: NormalizationSegment[];
}

/** extraction/<revision>/source-map.json */
export interface SourceMapDocument {
  schemaVersion: typeof SCHEMA_VERSION;
  pdfSha256: string;
  extractionRevision: string;
  pdfjsVersion: string;
  textItems: TextItemRecord[];
  normalizationMaps: NormalizationMap[];
}

// ───────────────────────── 세대 (generations/<generationId>) ─────────────────────────

export interface GlossaryEntry {
  id: string;
  term: string;
  aliases: string[];
  preferredKo: string;
  displayRule: string;
  meaningInPaper: string;
  evidenceSentenceIds: string[];
  conceptIds: string[];
}

export interface Reference {
  sourceId: string;
  evidenceIds: string[];
  supports: string;
}

export interface Concept {
  id: string;
  name: string;
  definitionKo: string;
  whyItMatters: string;
  exampleKo?: string | null;
  prerequisiteConceptIds: string[];
  refs: Reference[];
  researchStatus: ResearchStatus;
  contextVersion: number;
}

export interface Coverage {
  sectionId: string;
  startSentenceId: string;
  endSentenceId: string;
  jobId: string;
  status: 'covered' | 'partial' | 'missing';
  warnings: string[];
}

export interface SectionDigest {
  sectionId: string;
  summary: string;
  claims: string[];
  termCandidates: string[];
  evidenceSentenceIds: string[];
  unresolved: string[];
}

/** generations/<gid>/context.json */
export interface ContextDocument {
  schemaVersion: typeof SCHEMA_VERSION;
  version: number;
  promptVersion: string;
  summary: string;
  researchQuestion: string;
  contributions: string[];
  methodOverview: string;
  mainResults: string[];
  limitations: string[];
  glossary: GlossaryEntry[];
  concepts: Concept[];
  sectionDigests: SectionDigest[];
  coverage: Coverage[];
  unresolved: string[];
  createdAt: string;
}

export interface Source {
  id: string;
  discoveredUrl: string;
  finalUrl: string;
  title: string;
  publisher?: string | null;
  sourceType: string;
  discoveredBy: DiscoveredBy;
  discoveredAt: string;
  fetchedAt: string;
  httpStatus: number;
  contentType: string;
  contentHash: string;
  fetchStatus: FetchStatus;
  truncated: boolean;
  evidenceIds: string[];
}

export interface Evidence {
  id: string;
  sourceId: string;
  excerpt: string;
  documentLocation?: string | null;
  excerptHash: string;
  retrievalRequestId: string;
  deliveredToJobIds: string[];
}

/** generations/<gid>/research.json */
export interface ResearchDocument {
  schemaVersion: typeof SCHEMA_VERSION;
  sources: Source[];
  evidence: Evidence[];
}

export interface BudgetCounters {
  searchRequests: number;
  fetchRequests: number;
  toolCalls: number;
}

export interface RequestReservation {
  id: string;
  jobId: string;
  parentRequestId?: string | null;
  kind: 'search' | 'fetch';
  queryOrUrlHash: string;
  reservedAt: string;
  state: ReservationState;
  completedAt?: string | null;
  responseSourceId?: string | null;
}

export interface Budget {
  scopeId: string;
  scopeType: 'pass1' | 'pass2_paper' | 'pass2_chunk';
  generationId: string;
  limits: BudgetCounters;
  used: BudgetCounters;
  reservations: RequestReservation[];
  revision: number;
  updatedAt: string;
}

/** generations/<gid>/budget.json */
export interface BudgetDocument {
  schemaVersion: typeof SCHEMA_VERSION;
  budgets: Budget[];
}

export interface Failure {
  id: string;
  stage: string;
  code: string;
  message: string;
  retryable: boolean;
  attempt: number;
  occurredAt: string;
  nextRetryAt?: string | null;
}

/** 모델이 반환하고 앱이 검증한 문장 결과. */
export interface SentenceResult {
  id: string;
  ko: string;
  note: string;
  refs: Reference[];
  conceptIds: string[];
  warnings: string[];
}

/** generations/<gid>/chunks/<chunkId>.json */
export interface ChunkDocument {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  sectionId: string;
  targetSentenceIds: string[];
  neighborSentenceIds: string[];
  inputHash: string;
  contextVersion: number;
  status: WorkStatus;
  attempts: number;
  results: SentenceResult[];
  resultHash?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  nextRetryAt?: string | null;
  jobId?: string | null;
  threadId?: string | null;
  turnId?: string | null;
  lastError?: Failure | null;
}

// ───────────────────────── manifest.json ─────────────────────────

export interface Usage {
  logicalJobs: number;
  turnCount: number;
  reportedModelCalls?: number | null;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  elapsedMs: number;
}

export interface GenerationInfo {
  generationId: string;
  extractionRevision: string;
  promptVersion: string;
  contextVersion: number;
  provider: string;
  runtimeVersion: string;
  modelId?: string | null;
  createdAt: string;
}

export interface FileHashEntry {
  path: string;
  sha256: string;
}

export interface Manifest {
  schemaVersion: typeof SCHEMA_VERSION;
  pdfSha256: string;
  state: PaperState;
  currentExtractionRevision?: string | null;
  currentGenerationId?: string | null;
  generations: GenerationInfo[];
  files: FileHashEntry[];
  usage: Usage;
  errors: Failure[];
  updatedAt: string;
}
