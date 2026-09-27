/**
 * 2차 패스에서 모델이 돌려주는 JSON(COMMIT_PLAN C2.5, 0.3-4).
 * `kind`로 나뉘는 판별 유니온이다. M2에는 조사가 없어 `results`만 허용한다.
 * `needsResearch`는 M4에서 추가하고, 보충 조사 뒤 재시도 턴에는 다시 이 스키마를 쓴다.
 * refs와 conceptIds는 받지 않는다. 제공한 자료가 없으므로 앱이 빈 배열로 채운다.
 */
export interface ChunkModelSentence {
  id: string;
  ko: string;
  note: string;
  warnings: string[];
}

export interface ChunkModelOutput {
  kind: 'results';
  results: ChunkModelSentence[];
}

export const CHUNK_OUTPUT_SCHEMA_VERSION = '1';

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
        required: ['id', 'ko', 'note', 'warnings'],
        properties: {
          id: { type: 'string', description: 'TARGET_SENTENCES의 id 그대로' },
          ko: { type: 'string', description: '한국어 번역. [EQ_n]과 인용 표시는 그대로 둔다' },
          note: { type: 'string', description: '초보자용 해설. 필요 없으면 빈 문자열' },
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
