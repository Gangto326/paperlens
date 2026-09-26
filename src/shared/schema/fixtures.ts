/** 테스트·개발용 최소 유효 샘플. 스키마 변경 시 함께 갱신한다. */
import type {
  BudgetDocument,
  ChunkDocument,
  ContextDocument,
  ExtractionDocument,
  Manifest,
  ResearchDocument,
  SourceMapDocument,
} from './types';

export const SAMPLE_SHA = 'a'.repeat(64);
const NOW = '2026-09-26T00:00:00.000Z';

export const sampleManifest: Manifest = {
  schemaVersion: 1,
  pdfSha256: SAMPLE_SHA,
  state: 'imported',
  currentExtractionRevision: null,
  currentGenerationId: null,
  generations: [],
  files: [],
  usage: { logicalJobs: 0, turnCount: 0, elapsedMs: 0 },
  errors: [],
  updatedAt: NOW,
};

export const sampleExtraction: ExtractionDocument = {
  schemaVersion: 1,
  paper: {
    id: 'paper_1',
    pdfSha256: SAMPLE_SHA,
    fileName: 'sample.pdf',
    authors: [],
    pageCount: 1,
    importedAt: NOW,
  },
  pipeline: {
    extractionRevision: 'rev_1',
    parserName: 'grobid',
    parserVersion: '0.9.1',
    parserConfigHash: 'cfg',
    pdfjsVersion: '6.3.289',
    normalizerVersion: '1',
    segmenterVersion: 'grobid',
  },
  pages: [
    {
      pageIndex: 0,
      pdfPageNumber: 1,
      width: 612,
      height: 792,
      rotation: 0,
      userUnit: 1,
      mediaBox: [0, 0, 612, 792],
      cropBox: [0, 0, 612, 792],
      coordinateSpace: 'pdf_user_space',
      textQuality: 'ok',
      warnings: [],
    },
  ],
  sections: [{ id: 'sec_1', title: 'Introduction', order: 0, sentenceIds: ['s_1'] }],
  sentences: [
    {
      id: 's_1',
      order: 0,
      page: 0,
      pages: [0],
      sectionId: 'sec_1',
      paragraphId: 'p_1',
      kind: 'sentence',
      enRaw: 'We study RAG.',
      en: 'We study RAG.',
      sourceSpans: [
        {
          pageIndex: 0,
          textItemId: 't_0_0',
          utf16Start: 0,
          utf16End: 13,
          normalizedStart: 0,
          normalizedEnd: 13,
          normalizationMapId: 'nm_0',
        },
      ],
      rects: [
        {
          pageIndex: 0,
          x: 72,
          y: 72,
          width: 100,
          height: 12,
          coordinateSpace: 'grobid_top_left_pdf_units',
          transformVersion: '1',
        },
      ],
      mappingStatus: 'mapped',
      mappingConfidence: 1,
      equations: [],
      citationMarkers: [],
      warnings: [],
    },
  ],
  excludedBlocks: [],
  bibliography: [],
  warnings: [],
};

export const sampleSourceMap: SourceMapDocument = {
  schemaVersion: 1,
  pdfSha256: SAMPLE_SHA,
  extractionRevision: 'rev_1',
  pdfjsVersion: '6.3.289',
  textItems: [
    {
      id: 't_0_0',
      pageIndex: 0,
      index: 0,
      str: 'We study RAG.',
      transform: [10, 0, 0, 10, 72, 700],
      width: 100,
      height: 10,
      fontName: 'g_d0_f1',
      dir: 'ltr',
      hasEOL: true,
    },
  ],
  fonts: [{ id: 'g_d0_f1', name: 'ABCDEF+NimbusRomNo9L-Regu', family: 'serif' }],
  normalizationMaps: [
    {
      id: 'nm_0',
      version: '1',
      segments: [{ rawStart: 0, rawEnd: 13, normStart: 0, normEnd: 13, kind: 'copy' }],
    },
  ],
};

export const sampleContext: ContextDocument = {
  schemaVersion: 1,
  version: 1,
  promptVersion: 'ctx_v1',
  summary: '요약',
  researchQuestion: '연구 문제',
  contributions: [],
  methodOverview: '',
  mainResults: [],
  limitations: [],
  glossary: [],
  concepts: [],
  sectionDigests: [],
  coverage: [
    {
      sectionId: 'sec_1',
      startSentenceId: 's_1',
      endSentenceId: 's_1',
      jobId: 'job_1',
      status: 'covered',
      warnings: [],
    },
  ],
  unresolved: [],
  createdAt: NOW,
};

export const sampleResearch: ResearchDocument = { schemaVersion: 1, sources: [], evidence: [] };

export const sampleBudget: BudgetDocument = {
  schemaVersion: 1,
  budgets: [
    {
      scopeId: 'gen_1:pass1',
      scopeType: 'pass1',
      generationId: 'gen_1',
      limits: { searchRequests: 8, fetchRequests: 16, toolCalls: 32 },
      used: { searchRequests: 0, fetchRequests: 0, toolCalls: 0 },
      reservations: [],
      revision: 0,
      updatedAt: NOW,
    },
  ],
};

export const sampleChunk: ChunkDocument = {
  schemaVersion: 1,
  id: 'chunk_1',
  sectionId: 'sec_1',
  targetSentenceIds: ['s_1'],
  neighborSentenceIds: [],
  inputHash: 'h',
  contextVersion: 1,
  status: 'pending',
  attempts: 0,
  results: [],
};
