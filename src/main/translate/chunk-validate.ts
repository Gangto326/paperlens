import {
  EXPLANATION_FIELDS,
  type Sentence,
  type SentenceExplanation,
  type SentenceResult,
} from '@shared/schema';
import type { ChunkModelOutput } from './chunk-output';

/**
 * 청크 결과 검증기(COMMIT_PLAN C2.6, PLAN 6.4의 검사). 스키마를 통과한 출력에 대해 본다.
 * fatal이 하나라도 있으면 청크를 완료로 저장하지 않는다. warning은 그 문장의 warnings에 남기고 저장한다.
 *
 * | 코드 | 심각도 | 뜻 |
 * | missing_id / duplicate_id / unexpected_id | fatal | 반환 ID 집합이 대상과 다르다 |
 * | empty_translation | fatal | 원문이 있는데 번역이 비었다 |
 * | placeholder_lost / placeholder_added | fatal | [EQ_n] 개수가 원문과 다르다 |
 * | citation_lost | fatal | 원문의 인용 표시가 번역에 없다 |
 * | neighbor_content | fatal | 문맥 문장에만 있는 인용·수치·원문이 번역에 들어 있다 |
 * | invented_url | fatal | 원문에 없는 URL이 번역이나 해설에 있다 |
 * | unknown_concept | warning | 입력에 없는 개념 카드 id. 그 id만 버린다 |
 * | number_missing | warning | 원문의 수치가 번역에 없다(숫자를 글로 풀어 쓴 경우일 수 있다) |
 *   단위가 붙은 수(400M, 10k)는 비교하지 않는다. 실제 번역에서 4억, 2,100만으로 옮긴 것이 경고로 나왔기 때문이다.
 *
 * refs는 이 단계에서 모델에게 받지 않으므로 검사할 것이 없다. 출처 ID 검사는 조사가 붙는 M4에서 추가한다.
 * 문맥 문장 혼입은 표시(인용·수치·원문 그대로)가 있을 때만 잡는다. 표시 없이 뜻만 섞인 경우는 잡지 못한다.
 */
export type ChunkIssueCode =
  | 'missing_id'
  | 'duplicate_id'
  | 'unexpected_id'
  | 'empty_translation'
  | 'placeholder_lost'
  | 'placeholder_added'
  | 'citation_lost'
  | 'neighbor_content'
  | 'invented_url'
  | 'unknown_concept'
  | 'number_missing';

export interface ChunkIssue {
  code: ChunkIssueCode;
  severity: 'fatal' | 'warning';
  /** 원래 문장 ID. 어느 대상에도 묶이지 않으면 null. */
  sentenceId: string | null;
  detail: string;
}

export interface ChunkValidation {
  ok: boolean;
  issues: ChunkIssue[];
  /** 대상 문장 순서. fatal이 있어도 ID가 맞는 문장의 결과는 들어 있다(진단·부분 재사용용). */
  results: SentenceResult[];
}

const PLACEHOLDER = /\[EQ_\d+\]/g;
// URL에 쓰는 ASCII 글자만 잇는다. 한국어 조사가 바로 붙어도(`…/rag/에서`) URL에 들어가지 않는다.
const URL = /https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%]+/gi;

/** 문장 끝 구두점은 URL이 아니다. */
const urlsIn = (text: string): string[] =>
  [...text.matchAll(URL)].map((m) => m[0].replace(/[.,;:!?]+$/, ''));
const NUMBER = /\d+(?:[.,]\d+)*/g;

const squeeze = (text: string): string => text.replace(/\s+/g, '');

const countOf = (text: string, pattern: RegExp): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(pattern)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  return counts;
};

const normalizeNumber = (n: string): string => n.replace(/,(?=\d{3}(?!\d))/g, '');

/** 자리표시자와 인용 표시를 뺀 글에서 수치를 뽑는다. */
export function numbersIn(text: string, citationMarkers: readonly string[]): string[] {
  let body = text.replace(PLACEHOLDER, ' ');
  for (const marker of citationMarkers) body = body.split(marker).join(' ');
  // 남은 대괄호 인용([3], [3, 4])도 수치로 치지 않는다.
  body = body.replace(/\[\s*\d+(?:\s*[,–-]\s*\d+)*\s*\]/g, ' ');
  const found: string[] = [];
  for (const m of body.matchAll(NUMBER)) {
    // 400M, 21M, 10k처럼 단위가 붙은 수는 4억, 2,100만처럼 옮기는 것이 자연스럽다. 비교하지 않는다.
    const rest = body.slice(m.index + m[0].length);
    if (/^\s?[MBKk](?![A-Za-z])/.test(rest)) continue;
    found.push(normalizeNumber(m[0]));
  }
  return [...new Set(found)];
}

const hasNumber = (text: string, n: string): boolean => {
  const found = [...text.matchAll(NUMBER)].map((m) => normalizeNumber(m[0]));
  return found.includes(n);
};

export function validateChunkOutput(
  output: ChunkModelOutput,
  input: {
    targets: readonly Sentence[];
    neighbors: readonly Sentence[];
    /** 프롬프트용 별칭 → 원래 ID */
    toId: (alias: string) => string | undefined;
    /** 입력으로 준 개념 카드 id. 없으면 개념 연결을 모두 버린다. */
    conceptIds?: ReadonlySet<string>;
  },
): ChunkValidation {
  const issues: ChunkIssue[] = [];
  const fatal = (code: ChunkIssueCode, sentenceId: string | null, detail: string): void => {
    issues.push({ code, severity: 'fatal', sentenceId, detail });
  };

  const targetById = new Map(input.targets.map((s) => [s.id, s]));
  const accepted = new Map<
    string,
    { ko: string; explanation: SentenceExplanation; conceptIds: string[]; warnings: string[] }
  >();
  for (const r of output.results) {
    const id = input.toId(r.id);
    if (id === undefined || !targetById.has(id)) {
      fatal('unexpected_id', null, `대상이 아닌 id: ${r.id}`);
      continue;
    }
    if (accepted.has(id)) {
      fatal('duplicate_id', id, `같은 문장을 두 번 돌려줬습니다: ${r.id}`);
      continue;
    }
    accepted.set(id, {
      ko: r.ko.trim(),
      explanation: {
        main: r.explain.trim(),
        caution: r.caution.trim(),
        plain: '',
        role: '',
        example: r.example.trim(),
        deeper: '',
      },
      conceptIds: [...new Set(r.conceptIds.map((c) => c.trim()).filter((c) => c !== ''))],
      warnings: r.warnings.map((w) => w.trim()).filter((w) => w !== ''),
    });
  }

  const neighborText = input.neighbors.map((s) => s.en);
  const neighborSqueezed = neighborText.map((t) => squeeze(t).toLowerCase());
  const results: SentenceResult[] = [];
  for (const sentence of input.targets) {
    const got = accepted.get(sentence.id);
    if (!got) {
      fatal('missing_id', sentence.id, '결과가 없습니다');
      continue;
    }
    const warnings = [...got.warnings];
    if (sentence.en.trim() !== '' && got.ko === '') {
      fatal('empty_translation', sentence.id, '번역이 비어 있습니다');
    }

    const want = countOf(sentence.en, PLACEHOLDER);
    const have = countOf(got.ko, PLACEHOLDER);
    for (const [token, n] of want) {
      const m = have.get(token) ?? 0;
      if (m < n) fatal('placeholder_lost', sentence.id, `${token} 원문 ${n}개, 번역 ${m}개`);
      if (m > n) fatal('placeholder_added', sentence.id, `${token} 원문 ${n}개, 번역 ${m}개`);
    }
    for (const [token, m] of have) {
      if (!want.has(token)) {
        fatal('placeholder_added', sentence.id, `${token} 원문 0개, 번역 ${m}개`);
      }
    }

    const koSqueezed = squeeze(got.ko);
    for (const marker of new Set(sentence.citationMarkers)) {
      if (!koSqueezed.includes(squeeze(marker))) {
        fatal('citation_lost', sentence.id, `인용 표시 ${marker}가 번역에 없습니다`);
      }
    }

    const sourceUrls = new Set(urlsIn(sentence.en));
    for (const url of urlsIn(
      [got.ko, ...EXPLANATION_FIELDS.map((k) => got.explanation[k] ?? '')].join('\n'),
    )) {
      if (!sourceUrls.has(url)) {
        fatal('invented_url', sentence.id, `원문에 없는 URL: ${url}`);
      }
    }

    // 문맥 문장 혼입: 원문에는 없고 문맥 문장에만 있는 표시가 번역에 들어 있는지 본다.
    const enSqueezed = squeeze(sentence.en);
    const foreign = new Set<string>();
    for (const neighbor of input.neighbors) {
      for (const marker of neighbor.citationMarkers) {
        const key = squeeze(marker);
        // `3]` 같은 조각은 다른 인용의 일부와 겹칠 수 있어 대괄호로 닫힌 표시만 본다.
        if (!/^\[.*\]$/.test(key)) continue;
        if (!enSqueezed.includes(key) && koSqueezed.includes(key)) foreign.add(marker);
      }
    }
    const koLower = koSqueezed.toLowerCase();
    neighborSqueezed.forEach((text, i) => {
      if (text.length >= 24 && koLower.includes(text)) {
        foreign.add(`원문 그대로: ${(neighborText[i] ?? '').slice(0, 40)}`);
      }
    });
    for (const mark of foreign) {
      fatal('neighbor_content', sentence.id, `문맥 문장의 내용이 들어 있습니다: ${mark}`);
    }

    for (const n of numbersIn(sentence.en, sentence.citationMarkers)) {
      if (!hasNumber(got.ko, n)) {
        issues.push({
          code: 'number_missing',
          severity: 'warning',
          sentenceId: sentence.id,
          detail: `수치 ${n}가 번역에 없습니다`,
        });
        warnings.push(`number_missing: ${n}`);
      }
    }

    const conceptIds: string[] = [];
    for (const conceptId of got.conceptIds) {
      if (input.conceptIds?.has(conceptId)) conceptIds.push(conceptId);
      else {
        issues.push({
          code: 'unknown_concept',
          severity: 'warning',
          sentenceId: sentence.id,
          detail: `입력에 없는 개념 카드 id: ${conceptId}`,
        });
      }
    }

    results.push({
      id: sentence.id,
      ko: got.ko,
      note: '',
      explanation: got.explanation,
      refs: [],
      conceptIds,
      warnings,
    });
  }

  return { ok: issues.every((i) => i.severity !== 'fatal'), issues, results };
}

/** 코드별 개수. 로그와 실패 문구에 쓴다. */
export function summarizeIssues(issues: readonly ChunkIssue[]): string {
  const counts = new Map<string, number>();
  for (const issue of issues) counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
  return [...counts].map(([code, n]) => `${code} ${n}`).join(', ');
}
