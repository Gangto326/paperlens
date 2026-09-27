/**
 * 1차 패스(도구 없음)에서 모델이 돌려주는 JSON(COMMIT_PLAN C2.3).
 * 캐시의 ContextDocument보다 작다. ID·버전·시각·jobId는 앱이 붙인다. 조사가 없으므로 concepts는 받지 않는다.
 * 구조화 출력 제약에 맞춰 모든 필드를 필수로 두고 길이 제한 같은 키워드는 쓰지 않는다.
 */
export interface ContextModelGlossaryEntry {
  term: string;
  aliases: string[];
  preferredKo: string;
  displayRule: string;
  meaningInPaper: string;
  evidenceSentenceIds: string[];
}

export interface ContextModelCoverage {
  sectionId: string;
  startSentenceId: string;
  endSentenceId: string;
  status: 'covered' | 'partial' | 'missing';
}

export interface ContextModelOutput {
  summary: string;
  researchQuestion: string;
  contributions: string[];
  methodOverview: string;
  mainResults: string[];
  limitations: string[];
  glossary: ContextModelGlossaryEntry[];
  unresolved: string[];
  coverage: ContextModelCoverage[];
}

const str = { type: 'string' } as const;
const strArr = { type: 'array', items: str } as const;

export const CONTEXT_OUTPUT_SCHEMA_VERSION = '1';

export const CONTEXT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'summary',
    'researchQuestion',
    'contributions',
    'methodOverview',
    'mainResults',
    'limitations',
    'glossary',
    'unresolved',
    'coverage',
  ],
  properties: {
    summary: { ...str, description: '논문 전체를 한 문단으로 요약한 한국어 글' },
    researchQuestion: { ...str, description: '이 논문이 풀려는 문제(한국어)' },
    contributions: { ...strArr, description: '기여 목록(한국어)' },
    methodOverview: { ...str, description: '방법 개요(한국어)' },
    mainResults: { ...strArr, description: '본문에 근거한 주요 결과(한국어)' },
    limitations: { ...strArr, description: '본문에 근거한 한계(한국어)' },
    glossary: {
      type: 'array',
      description: '핵심 용어·약어·기호와 한국어 표기 규칙',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'term',
          'aliases',
          'preferredKo',
          'displayRule',
          'meaningInPaper',
          'evidenceSentenceIds',
        ],
        properties: {
          term: { ...str, description: '논문에 나온 원어 표기' },
          aliases: { ...strArr, description: '약어·다른 표기' },
          preferredKo: { ...str, description: '번역에서 쓸 한국어 표기' },
          displayRule: {
            ...str,
            description: '표기 규칙. 예: 첫 등장에 원어 병기, 원어 유지, 음차',
          },
          meaningInPaper: { ...str, description: '이 논문 문맥에서의 뜻(한국어)' },
          evidenceSentenceIds: { ...strArr, description: '근거 문장 id. 입력에 있는 id만 쓴다' },
        },
      },
    },
    unresolved: {
      ...strArr,
      description: '조사가 필요한 배경 개념, 뜻이 불명확한 용어, 확인할 수 없는 주장',
    },
    coverage: {
      type: 'array',
      description: '입력의 모든 섹션에 대해 읽은 문장 범위',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sectionId', 'startSentenceId', 'endSentenceId', 'status'],
        properties: {
          sectionId: str,
          startSentenceId: str,
          endSentenceId: str,
          status: { type: 'string', enum: ['covered', 'partial', 'missing'] },
        },
      },
    },
  },
} as const;
