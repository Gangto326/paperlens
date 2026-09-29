import { describe, expect, it } from 'vitest';
import type { Sentence } from '@shared/schema';
import type { ChunkModelOutput, ChunkModelSentence } from './chunk-output';
import { numbersIn, summarizeIssues, validateChunkOutput } from './chunk-validate';

const sentence = (
  id: string,
  order: number,
  en: string,
  citationMarkers: string[] = [],
): Sentence => ({
  id,
  order,
  page: 0,
  pages: [0],
  sectionId: 'sec_1',
  paragraphId: 'p_1',
  kind: 'sentence',
  enRaw: en,
  en,
  sourceSpans: [],
  rects: [],
  mappingStatus: 'mapped',
  equations: [],
  citationMarkers,
  warnings: [],
});

const BEFORE = sentence('id_before', 0, 'Dense retrieval was introduced earlier [31].', ['[31]']);
const A = sentence('id_a', 1, 'We marginalize [EQ_1] over the top 5 documents [26].', ['[26]']);
const B = sentence('id_b', 2, 'The score is [EQ_1] and [EQ_2], see [8, 9].', ['[8,', '9]']);
const C = sentence('id_c', 3, 'Code is at https://example.org/rag and accuracy is 44.5%.');
const AFTER = sentence('id_after', 4, 'Training takes 1,000 steps.');

const ALIAS: Record<string, string> = {
  s1: 'id_before',
  s2: 'id_a',
  s3: 'id_b',
  s4: 'id_c',
  s5: 'id_after',
};
const input = {
  targets: [A, B, C],
  neighbors: [BEFORE, AFTER],
  toId: (alias: string): string | undefined => ALIAS[alias.trim()],
};

const row = (id: string, ko: string, caution = ''): ChunkModelSentence => ({
  id,
  ko,
  explain: '',
  example: '',
  caution,
  conceptIds: [],
  warnings: [],
});
const GOOD: ChunkModelSentence[] = [
  row('s2', '상위 5개 문서에 대해 [EQ_1]을 주변화한다 [26].'),
  row('s3', '점수는 [EQ_1]과 [EQ_2]이다. [8, 9]를 보라.'),
  row('s4', '코드는 https://example.org/rag 에 있고 정확도는 44.5%이다.'),
];
const check = (results: ChunkModelSentence[]): ReturnType<typeof validateChunkOutput> =>
  validateChunkOutput({ kind: 'results', results } satisfies ChunkModelOutput, input);
const codes = (results: ChunkModelSentence[]): [string, string | null][] =>
  check(results).issues.map((i) => [i.code, i.sentenceId]);
const replaced = (index: number, ko: string, caution = ''): ChunkModelSentence[] =>
  GOOD.map((r, i) => (i === index ? row(r.id, ko, caution) : r));

describe('validateChunkOutput', () => {
  it('정상 결과는 문제가 없고 대상 문장 순서의 원래 ID로 나온다', () => {
    const v = check([...GOOD].reverse());
    expect(v.ok).toBe(true);
    expect(v.issues).toEqual([]);
    expect(v.results.map((r) => r.id)).toEqual(['id_a', 'id_b', 'id_c']);
    expect(v.results[0]).toMatchObject({ refs: [], conceptIds: [], warnings: [] });
  });

  it('누락 ID', () => {
    expect(codes(GOOD.slice(0, 2))).toEqual([['missing_id', 'id_c']]);
  });

  it('중복 ID', () => {
    const first = GOOD[0];
    if (!first) throw new Error('fixture');
    expect(codes([...GOOD, first])).toEqual([['duplicate_id', 'id_a']]);
  });

  it('추가 ID: 모르는 id, 문맥 문장의 id, 원래 ID 그대로', () => {
    expect(codes([...GOOD, row('s99', 'x')])).toEqual([['unexpected_id', null]]);
    expect(codes([...GOOD, row('s1', '밀집 검색은 앞서 소개되었다 [31].')])).toEqual([
      ['unexpected_id', null],
    ]);
    expect(codes([...GOOD, row('id_a', 'x')])).toEqual([['unexpected_id', null]]);
  });

  it('[EQ_n] 삭제·중복·변형·추가', () => {
    expect(codes(replaced(0, '상위 5개 문서에 대해 주변화한다 [26].'))).toEqual([
      ['placeholder_lost', 'id_a'],
    ]);
    expect(codes(replaced(0, '상위 5개 문서에 대해 [EQ_1], [EQ_1]을 주변화한다 [26].'))).toEqual([
      ['placeholder_added', 'id_a'],
    ]);
    expect(codes(replaced(0, '상위 5개 문서에 대해 [EQ1]을 주변화한다 [26].'))).toEqual([
      ['placeholder_lost', 'id_a'],
    ]);
    expect(codes(replaced(1, '점수는 [EQ_1]과 [EQ_3]이다. [8, 9]를 보라.'))).toEqual([
      ['placeholder_lost', 'id_b'],
      ['placeholder_added', 'id_b'],
    ]);
  });

  it('인용 표시 손실. 공백 차이는 손실이 아니다', () => {
    expect(codes(replaced(0, '상위 5개 문서에 대해 [EQ_1]을 주변화한다.'))).toEqual([
      ['citation_lost', 'id_a'],
    ]);
    expect(codes(replaced(1, '점수는 [EQ_1]과 [EQ_2]이다. [8,9]를 보라.'))).toEqual([]);
    expect(codes(replaced(1, '점수는 [EQ_1]과 [EQ_2]이다. [8]을 보라.'))).toEqual([
      ['citation_lost', 'id_b'],
      ['citation_lost', 'id_b'],
    ]);
  });

  it('이웃 문장 포함: 문맥 문장의 인용 표시나 원문이 번역에 들어 있다', () => {
    expect(
      codes(
        replaced(
          0,
          '밀집 검색은 앞서 소개되었다 [31]. 상위 5개 문서에 대해 [EQ_1]을 주변화한다 [26].',
        ),
      ),
    ).toEqual([['neighbor_content', 'id_a']]);
    expect(
      codes(
        replaced(0, '상위 5개 문서에 대해 [EQ_1]을 주변화한다 [26]. Training takes 1,000 steps.'),
      ),
    ).toEqual([['neighbor_content', 'id_a']]);
  });

  it('빈 번역과 지어낸 URL', () => {
    expect(codes(replaced(2, '  '))).toEqual([
      ['empty_translation', 'id_c'],
      ['number_missing', 'id_c'],
    ]);
    expect(
      codes(
        replaced(0, '상위 5개 문서에 대해 [EQ_1]을 주변화한다 [26].', 'https://evil.example 참고'),
      ),
    ).toEqual([['invented_url', 'id_a']]);
    // 원문에 있는 URL은 그대로 써도 된다.
    expect(check(GOOD).ok).toBe(true);
    // 실제 실행에서 나온 오탐: URL 바로 뒤에 조사가 붙거나 문장 부호로 끝나는 경우.
    expect(
      codes(replaced(2, '코드는 https://example.org/rag에서 볼 수 있고 정확도는 44.5%이다.')),
    ).toEqual([]);
    expect(codes(replaced(2, '정확도는 44.5%이고 코드는 https://example.org/rag.'))).toEqual([]);
    expect(
      codes(replaced(2, '정확도는 44.5%이고 코드는 https://example.org/rag2에 있다.')),
    ).toEqual([['invented_url', 'id_c']]);
  });

  it('해설 칸은 다듬어 저장하고, 입력에 없는 개념 id는 버리고 경고로 남긴다', () => {
    const first = GOOD[0];
    if (!first) throw new Error('fixture');
    const v = validateChunkOutput(
      {
        kind: 'results',
        results: [
          {
            ...first,
            explain: ' 해설 글 ',
            example: '',
            caution: ' ',
            conceptIds: ['c_2', ' c_1 ', 'c_404', 'c_2'],
          },
          ...GOOD.slice(1),
        ],
      },
      { ...input, conceptIds: new Set(['c_1', 'c_2']) },
    );
    expect(v.ok).toBe(true);
    expect(v.issues.map((i) => [i.code, i.severity, i.sentenceId])).toEqual([
      ['unknown_concept', 'warning', 'id_a'],
    ]);
    expect(v.results[0]).toMatchObject({
      note: '',
      explanation: { main: '해설 글', caution: '', plain: '', role: '', example: '', deeper: '' },
      conceptIds: ['c_2', 'c_1'],
      warnings: [],
    });
    // 개념 목록을 주지 않으면 연결을 모두 버린다.
    expect(
      check([{ ...first, conceptIds: ['c_1'] }, ...GOOD.slice(1)]).results[0]?.conceptIds,
    ).toEqual([]);
  });

  it('수치 누락은 경고다. 저장은 하고 그 문장의 warnings에 남긴다', () => {
    const v = check(replaced(2, '코드는 https://example.org/rag 에 있고 정확도가 높다.'));
    expect(v.ok).toBe(true);
    expect(v.issues).toEqual([
      {
        code: 'number_missing',
        severity: 'warning',
        sentenceId: 'id_c',
        detail: '수치 44.5가 번역에 없습니다',
      },
    ]);
    expect(v.results[2]?.warnings).toEqual(['number_missing: 44.5']);
    // 숫자를 글로 풀어 쓴 경우도 경고로만 남는다.
    expect(check(replaced(0, '상위 다섯 개 문서에 대해 [EQ_1]을 주변화한다 [26].')).ok).toBe(true);
  });

  it('fatal이 있어도 ID가 맞는 문장의 결과는 돌려준다', () => {
    const v = check(GOOD.slice(0, 2));
    expect(v.ok).toBe(false);
    expect(v.results.map((r) => r.id)).toEqual(['id_a', 'id_b']);
  });
});

describe('numbersIn', () => {
  it('자리표시자와 인용 안의 숫자는 수치가 아니다', () => {
    expect(numbersIn('We use [EQ_12] and 5 docs [26] or [3, 4].', ['[26]'])).toEqual(['5']);
    expect(numbersIn('From 1,000 to 21,015,324 items, 44.5%.', [])).toEqual([
      '1000',
      '21015324',
      '44.5',
    ]);
  });

  it('단위가 붙은 수는 비교하지 않는다', () => {
    expect(numbersIn('BART has 400M parameters and 21 M documents, 10k steps.', [])).toEqual([]);
    expect(numbersIn('We use 5 Models and 3 KB.', [])).toEqual(['5', '3']);
  });
});

describe('summarizeIssues', () => {
  it('코드별 개수', () => {
    expect(summarizeIssues(check(GOOD.slice(0, 1)).issues)).toBe('missing_id 2');
  });
});
