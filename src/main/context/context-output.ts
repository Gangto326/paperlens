/**
 * 1차 패스(도구 없음)에서 모델이 돌려주는 JSON(COMMIT_PLAN C2.3).
 * 캐시의 ContextDocument보다 작다. ID·버전·시각·jobId는 앱이 붙인다.
 * concepts는 모델 지식으로 쓴 일반 설명이다. 조사가 없으므로 출처(refs)는 받지 않고
 * 앱이 researchStatus를 unresolved로 저장한다. 화면은 "일반 설명, 출처 미확인"으로 표시한다.
 * 개념끼리, 개념과 용어는 이름으로 잇고 앱이 id로 바꾼다.
 * 구조화 출력 제약에 맞춰 모든 필드를 필수로 두고 길이 제한 같은 키워드는 쓰지 않는다.
 */
export interface ContextModelGlossaryEntry {
  term: string;
  aliases: string[];
  preferredKo: string;
  acceptedKo: string[];
  displayRule: string;
  meaningInPaper: string;
  evidenceSentenceIds: string[];
}

export interface ContextModelConcept {
  name: string;
  nameKo: string;
  definitionKo: string;
  whyItMatters: string;
  exampleKo: string;
  prerequisites: string[];
  glossaryTerms: string[];
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
  concepts: ContextModelConcept[];
  unresolved: string[];
  coverage: ContextModelCoverage[];
}

const str = { type: 'string' } as const;
const strArr = { type: 'array', items: str } as const;

export const CONTEXT_OUTPUT_SCHEMA_VERSION = '2';

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
    'concepts',
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
          'acceptedKo',
          'displayRule',
          'meaningInPaper',
          'evidenceSentenceIds',
        ],
        properties: {
          term: { ...str, description: '논문에 나온 원어 표기' },
          aliases: { ...strArr, description: '약어·다른 표기' },
          preferredKo: {
            ...str,
            description: '번역에서 쓸 한국어 표기. 현업과 한국어 자료에서 통용되는 표기',
          },
          acceptedKo: {
            ...strArr,
            description:
              '선호 표기 대신 써도 되는 한국어 표기. 줄인 표기와 별칭의 번역을 포함한다. 없으면 빈 배열',
          },
          displayRule: {
            ...str,
            description: '표기 규칙. 예: 문단에서 처음 나올 때 괄호 안에 원어, 원어 유지',
          },
          meaningInPaper: { ...str, description: '이 논문 문맥에서의 뜻(한국어)' },
          evidenceSentenceIds: { ...strArr, description: '근거 문장 id. 입력에 있는 id만 쓴다' },
        },
      },
    },
    concepts: {
      type: 'array',
      description: '이 논문을 읽는 데 필요한 개념 카드. 개념마다 하나',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'name',
          'nameKo',
          'definitionKo',
          'whyItMatters',
          'exampleKo',
          'prerequisites',
          'glossaryTerms',
        ],
        properties: {
          name: { ...str, description: '개념의 원어 이름' },
          nameKo: { ...str, description: '통용되는 한국어 표기. 원어를 그대로 쓰면 빈 문자열' },
          definitionKo: { ...str, description: '뜻. 사전 지식이 없는 독자가 이해할 수 있게' },
          whyItMatters: { ...str, description: '이 논문에서 이 개념이 왜 중요한지' },
          exampleKo: { ...str, description: '구체적인 사례나 예시. 숫자나 상황이 있는 것' },
          prerequisites: {
            ...strArr,
            description: '먼저 알아야 하는 개념의 name. 이 목록의 다른 카드 이름만 쓴다',
          },
          glossaryTerms: {
            ...strArr,
            description: '이 카드가 설명하는 glossary 항목의 term. 없으면 빈 배열',
          },
        },
      },
    },
    unresolved: {
      ...strArr,
      description: '뜻이 불명확한 용어, 확인할 수 없는 주장, 일반 설명으로도 쓰기 어려운 개념',
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

/** 긴 논문의 통합 턴이 돌려주는 JSON(COMMIT_PLAN C3.1). coverage가 없다. 앱이 부분 작업의 장부로 채운다. */
export type ContextMergeModelOutput = Omit<ContextModelOutput, 'coverage'>;

export const CONTEXT_MERGE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: CONTEXT_OUTPUT_SCHEMA.required.filter((name) => name !== 'coverage'),
  properties: Object.fromEntries(
    Object.entries(CONTEXT_OUTPUT_SCHEMA.properties).filter(([name]) => name !== 'coverage'),
  ),
};
