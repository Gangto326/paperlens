/**
 * 2차 패스에서 모델이 돌려주는 JSON(COMMIT_PLAN C2.5, 0.3-4).
 * `kind`로 나뉘는 판별 유니온이다. M2에는 조사가 없어 `results`만 허용한다.
 * `needsResearch`는 M4에서 추가하고, 보충 조사 뒤 재시도 턴에는 다시 이 스키마를 쓴다.
 * refs는 받지 않는다. 제공한 자료가 없으므로 앱이 빈 배열로 채운다.
 * 해설은 이름 붙은 칸 넷으로 받는다. 구조화 출력 제약 때문에 모두 필수이고 쓸 말이 없으면 빈 문자열이다.
 * conceptIds는 입력 CONCEPTS에 있는 id만 쓴다. 없는 id는 검증기가 버린다.
 */
export interface ChunkModelSentence {
  id: string;
  ko: string;
  plain: string;
  role: string;
  example: string;
  deeper: string;
  conceptIds: string[];
  warnings: string[];
}

export interface ChunkModelOutput {
  kind: 'results';
  results: ChunkModelSentence[];
}

export const CHUNK_OUTPUT_SCHEMA_VERSION = '2';

export const CHUNK_RESULTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'results'],
  properties: {
    kind: { type: 'string', enum: ['results'] },
    results: {
      type: 'array',
      description: 'TARGET_SENTENCES의 각 문장에 대한 결과. 입력 순서대로, id마다 정확히 한 번',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'ko', 'plain', 'role', 'example', 'deeper', 'conceptIds', 'warnings'],
        properties: {
          id: { type: 'string', description: 'TARGET_SENTENCES의 id 그대로' },
          ko: { type: 'string', description: '한국어 번역. [EQ_n]과 인용 표시는 그대로 둔다' },
          plain: {
            type: 'string',
            description: '쉬운 뜻. 이 문장이 말하는 바를 쉬운 말로 풀어 쓴다',
          },
          role: {
            type: 'string',
            description: '이 문장이 논문 흐름에서 하는 역할. 앞뒤 문장과의 관계',
          },
          example: {
            type: 'string',
            description: '구체적 사례. 숫자나 상황이 있는 예. 쓸 것이 없으면 빈 문자열',
          },
          deeper: {
            type: 'string',
            description: '더 깊은 설명. 전제, 논리, 주의할 점. 쓸 것이 없으면 빈 문자열',
          },
          conceptIds: {
            type: 'array',
            items: { type: 'string' },
            description: '이 문장을 이해하는 데 필요한 개념 카드의 id. CONCEPTS에 있는 id만',
          },
          warnings: {
            type: 'array',
            items: { type: 'string' },
            description: '원문이 잘렸거나 뜻이 불명확할 때만 짧게 적는다. 없으면 빈 배열',
          },
        },
      },
    },
  },
} as const;
