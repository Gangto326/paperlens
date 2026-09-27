/**
 * 캐시 파일별 JSON Schema (draft-07, ajv). types.ts와 1:1로 유지한다.
 * 모든 객체는 additionalProperties: false. nullable 필드는 ["T","null"]로 표현하고 required에 포함한다
 * (필드 존재는 강제, 값은 null 허용). 선택 필드(`?`)는 required에서 뺀다.
 */

type JSONSchema = Record<string, unknown>;

const str: JSONSchema = { type: 'string' };
const num: JSONSchema = { type: 'number' };
const int: JSONSchema = { type: 'integer' };
const bool: JSONSchema = { type: 'boolean' };
const isoDate: JSONSchema = { type: 'string', minLength: 10 };
const nonEmpty: JSONSchema = { type: 'string', minLength: 1 };
const strArr: JSONSchema = { type: 'array', items: str };
const enumOf = (values: readonly string[]): JSONSchema => ({ type: 'string', enum: [...values] });
const nullable = (s: JSONSchema): JSONSchema => ({ anyOf: [s, { type: 'null' }] });
const arr = (items: JSONSchema): JSONSchema => ({ type: 'array', items });
const tuple = (n: number, item: JSONSchema): JSONSchema => ({
  type: 'array',
  items: item,
  minItems: n,
  maxItems: n,
});
/** 모든 키를 required로. optional 목록만 제외. */
const obj = (props: Record<string, JSONSchema>, optional: string[] = []): JSONSchema => ({
  type: 'object',
  additionalProperties: false,
  properties: props,
  required: Object.keys(props).filter((k) => !optional.includes(k)),
});
const schemaVersion: JSONSchema = { const: 1 };

export const PAPER_STATES = [
  'imported',
  'extracting',
  'mapping',
  'context_pending',
  'researching',
  'translating',
  'paused',
  'waiting_quota',
  'needs_login',
  'complete',
  'complete_with_gaps',
  'failed',
] as const;
export const WORK_STATUSES = [
  'pending',
  'running',
  'needs_research',
  'waiting_retry',
  'waiting_quota',
  'complete',
  'complete_with_gaps',
  'failed',
] as const;
export const MAPPING_STATUSES = ['mapped', 'uncertain', 'unmapped'] as const;
export const FETCH_STATUSES = ['read', 'partial', 'failed'] as const;
export const TEXT_QUALITIES = ['ok', 'sparse', 'garbled', 'needs_ocr'] as const;
export const COORDINATE_SPACES = ['grobid_top_left_pdf_units', 'pdf_user_space'] as const;
export const EXCLUDED_BLOCK_TYPES = [
  'figure',
  'table',
  'caption',
  'formula',
  'footnote',
  'bibliography',
  'header',
  'footer',
  'page_number',
  'other',
] as const;

const rect = obj({
  pageIndex: int,
  x: num,
  y: num,
  width: num,
  height: num,
  coordinateSpace: enumOf(COORDINATE_SPACES),
  transformVersion: str,
});

const sourceSpan = obj({
  pageIndex: int,
  textItemId: nonEmpty,
  utf16Start: int,
  utf16End: int,
  normalizedStart: int,
  normalizedEnd: int,
  normalizationMapId: nonEmpty,
});

const equationPlaceholder = obj(
  {
    id: nonEmpty,
    token: { type: 'string', pattern: '^\\[EQ_\\d+\\]$' },
    rawText: nullable(str),
    sourceSpans: arr(sourceSpan),
    rects: arr(rect),
    detectionStatus: enumOf(['detected', 'math_uncertain']),
    warning: nullable(str),
  },
  ['rawText', 'warning'],
);

const sentence = obj(
  {
    id: nonEmpty,
    order: int,
    page: int,
    pages: arr(int),
    sectionId: nonEmpty,
    paragraphId: nonEmpty,
    kind: enumOf(['sentence', 'fragment']),
    enRaw: str,
    en: str,
    sourceSpans: arr(sourceSpan),
    rects: arr(rect),
    mappingStatus: enumOf(MAPPING_STATUSES),
    mappingConfidence: nullable({ type: 'number', minimum: 0, maximum: 1 }),
    equations: arr(equationPlaceholder),
    citationMarkers: strArr,
    warnings: strArr,
  },
  ['mappingConfidence'],
);

const paper = obj(
  {
    id: nonEmpty,
    pdfSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    fileName: nonEmpty,
    originalPath: nullable(str),
    title: nullable(str),
    authors: strArr,
    year: nullable(int),
    doi: nullable(str),
    pageCount: { type: 'integer', minimum: 1 },
    importedAt: isoDate,
  },
  ['originalPath', 'title', 'year', 'doi'],
);

const pipeline = obj({
  extractionRevision: nonEmpty,
  parserName: nonEmpty,
  parserVersion: str,
  parserConfigHash: str,
  pdfjsVersion: nonEmpty,
  normalizerVersion: nonEmpty,
  segmenterVersion: nonEmpty,
});

const page = obj({
  pageIndex: int,
  pdfPageNumber: { type: 'integer', minimum: 1 },
  width: num,
  height: num,
  rotation: { type: 'integer', enum: [0, 90, 180, 270] },
  userUnit: { type: 'number', exclusiveMinimum: 0 },
  mediaBox: tuple(4, num),
  cropBox: tuple(4, num),
  coordinateSpace: enumOf(COORDINATE_SPACES),
  textQuality: enumOf(TEXT_QUALITIES),
  warnings: strArr,
});

const section = obj(
  { id: nonEmpty, parentId: nullable(str), title: str, order: int, sentenceIds: arr(nonEmpty) },
  ['parentId'],
);

const excludedBlock = obj(
  {
    id: nonEmpty,
    type: enumOf(EXCLUDED_BLOCK_TYPES),
    pageIndices: arr(int),
    rects: arr(rect),
    rawText: nullable(str),
    reason: str,
    confidence: nullable(num),
  },
  ['rawText', 'confidence'],
);

const bibliographicItem = obj(
  {
    id: nonEmpty,
    rawText: str,
    title: nullable(str),
    authors: strArr,
    year: nullable(int),
    doi: nullable(str),
    urlFromPdf: nullable(str),
    citingSentenceIds: strArr,
  },
  ['title', 'year', 'doi', 'urlFromPdf'],
);

export const extractionDocumentSchema = obj({
  schemaVersion,
  paper,
  pipeline,
  pages: arr(page),
  sections: arr(section),
  sentences: arr(sentence),
  excludedBlocks: arr(excludedBlock),
  bibliography: arr(bibliographicItem),
  warnings: strArr,
});

const textItemRecord = obj({
  id: nonEmpty,
  pageIndex: int,
  index: int,
  str: str,
  transform: tuple(6, num),
  width: num,
  height: num,
  fontName: str,
  dir: str,
  hasEOL: bool,
});

const fontRecord = obj({ id: nonEmpty, name: str, family: str });

const normalizationSegment = obj({
  rawStart: int,
  rawEnd: int,
  normStart: int,
  normEnd: int,
  kind: enumOf(['copy', 'ligature', 'space', 'hyphen', 'drop', 'insert']),
});

const normalizationMap = obj({
  id: nonEmpty,
  version: nonEmpty,
  segments: arr(normalizationSegment),
});

export const sourceMapDocumentSchema = obj({
  schemaVersion,
  pdfSha256: nonEmpty,
  extractionRevision: nonEmpty,
  pdfjsVersion: nonEmpty,
  textItems: arr(textItemRecord),
  fonts: arr(fontRecord),
  normalizationMaps: arr(normalizationMap),
});

const reference = obj({ sourceId: nonEmpty, evidenceIds: arr(nonEmpty), supports: str });

const glossaryEntry = obj({
  id: nonEmpty,
  term: nonEmpty,
  aliases: strArr,
  preferredKo: str,
  displayRule: str,
  meaningInPaper: str,
  evidenceSentenceIds: strArr,
  conceptIds: strArr,
});

const concept = obj(
  {
    id: nonEmpty,
    name: nonEmpty,
    definitionKo: str,
    whyItMatters: str,
    exampleKo: nullable(str),
    prerequisiteConceptIds: strArr,
    refs: arr(reference),
    researchStatus: enumOf(['researched', 'unresolved', 'not_needed']),
    contextVersion: int,
  },
  ['exampleKo'],
);

const coverage = obj({
  sectionId: nonEmpty,
  startSentenceId: nonEmpty,
  endSentenceId: nonEmpty,
  jobId: nonEmpty,
  status: enumOf(['covered', 'partial', 'missing']),
  warnings: strArr,
});

const sectionDigest = obj({
  sectionId: nonEmpty,
  summary: str,
  claims: strArr,
  termCandidates: strArr,
  evidenceSentenceIds: strArr,
  unresolved: strArr,
});

export const contextDocumentSchema = obj({
  schemaVersion,
  version: { type: 'integer', minimum: 1 },
  promptVersion: nonEmpty,
  summary: str,
  researchQuestion: str,
  contributions: strArr,
  methodOverview: str,
  mainResults: strArr,
  limitations: strArr,
  glossary: arr(glossaryEntry),
  concepts: arr(concept),
  sectionDigests: arr(sectionDigest),
  coverage: arr(coverage),
  unresolved: strArr,
  createdAt: isoDate,
});

const source = obj(
  {
    id: nonEmpty,
    discoveredUrl: nonEmpty,
    finalUrl: nonEmpty,
    title: str,
    publisher: nullable(str),
    sourceType: str,
    discoveredBy: enumOf(['search', 'bibliography']),
    discoveredAt: isoDate,
    fetchedAt: isoDate,
    httpStatus: int,
    contentType: str,
    contentHash: str,
    fetchStatus: enumOf(FETCH_STATUSES),
    truncated: bool,
    evidenceIds: arr(nonEmpty),
  },
  ['publisher'],
);

const evidence = obj(
  {
    id: nonEmpty,
    sourceId: nonEmpty,
    excerpt: str,
    documentLocation: nullable(str),
    excerptHash: str,
    retrievalRequestId: nonEmpty,
    deliveredToJobIds: strArr,
  },
  ['documentLocation'],
);

export const researchDocumentSchema = obj({
  schemaVersion,
  sources: arr(source),
  evidence: arr(evidence),
});

const counters = obj({
  searchRequests: { type: 'integer', minimum: 0 },
  fetchRequests: { type: 'integer', minimum: 0 },
  toolCalls: { type: 'integer', minimum: 0 },
});

const reservation = obj(
  {
    id: nonEmpty,
    jobId: nonEmpty,
    parentRequestId: nullable(str),
    kind: enumOf(['search', 'fetch']),
    queryOrUrlHash: nonEmpty,
    reservedAt: isoDate,
    state: enumOf(['reserved', 'sent', 'succeeded', 'failed', 'unknown']),
    completedAt: nullable(str),
    responseSourceId: nullable(str),
  },
  ['parentRequestId', 'completedAt', 'responseSourceId'],
);

const budget = obj({
  scopeId: nonEmpty,
  scopeType: enumOf(['pass1', 'pass2_paper', 'pass2_chunk']),
  generationId: nonEmpty,
  limits: counters,
  used: counters,
  reservations: arr(reservation),
  revision: int,
  updatedAt: isoDate,
});

export const budgetDocumentSchema = obj({ schemaVersion, budgets: arr(budget) });

const failure = obj(
  {
    id: nonEmpty,
    stage: nonEmpty,
    code: nonEmpty,
    message: str,
    retryable: bool,
    attempt: int,
    occurredAt: isoDate,
    nextRetryAt: nullable(str),
  },
  ['nextRetryAt'],
);

export const sentenceResultSchema = obj({
  id: nonEmpty,
  ko: str,
  note: str,
  refs: arr(reference),
  conceptIds: strArr,
  warnings: strArr,
});

export const chunkDocumentSchema = obj(
  {
    schemaVersion,
    id: nonEmpty,
    sectionId: nonEmpty,
    sectionIds: arr(nonEmpty),
    targetSentenceIds: arr(nonEmpty),
    neighborSentenceIds: arr(nonEmpty),
    inputHash: nonEmpty,
    contextVersion: int,
    status: enumOf(WORK_STATUSES),
    attempts: int,
    results: arr(sentenceResultSchema),
    resultHash: nullable(str),
    startedAt: nullable(str),
    completedAt: nullable(str),
    nextRetryAt: nullable(str),
    jobId: nullable(str),
    threadId: nullable(str),
    turnId: nullable(str),
    lastError: nullable(failure),
  },
  [
    'sectionIds',
    'resultHash',
    'startedAt',
    'completedAt',
    'nextRetryAt',
    'jobId',
    'threadId',
    'turnId',
    'lastError',
  ],
);

const usage = obj(
  {
    logicalJobs: int,
    turnCount: int,
    reportedModelCalls: nullable(int),
    inputTokens: nullable(int),
    cachedInputTokens: nullable(int),
    outputTokens: nullable(int),
    reasoningTokens: nullable(int),
    elapsedMs: int,
  },
  ['reportedModelCalls', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens'],
);

const generationInfo = obj(
  {
    generationId: nonEmpty,
    extractionRevision: nonEmpty,
    promptVersion: nonEmpty,
    contextVersion: int,
    provider: nonEmpty,
    runtimeVersion: str,
    modelId: nullable(str),
    createdAt: isoDate,
  },
  ['modelId'],
);

export const manifestSchema = obj(
  {
    schemaVersion,
    pdfSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    state: enumOf(PAPER_STATES),
    currentExtractionRevision: nullable(str),
    currentGenerationId: nullable(str),
    generations: arr(generationInfo),
    files: arr(obj({ path: nonEmpty, sha256: nonEmpty })),
    usage,
    errors: arr(failure),
    updatedAt: isoDate,
  },
  ['currentExtractionRevision', 'currentGenerationId'],
);

export const CACHE_SCHEMAS = {
  manifest: manifestSchema,
  extractionDocument: extractionDocumentSchema,
  sourceMapDocument: sourceMapDocumentSchema,
  contextDocument: contextDocumentSchema,
  researchDocument: researchDocumentSchema,
  budgetDocument: budgetDocumentSchema,
  chunkDocument: chunkDocumentSchema,
} as const;

export type CacheSchemaName = keyof typeof CACHE_SCHEMAS;
