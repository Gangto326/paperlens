import type { ConceptCard, ConceptSourceLink, TranslationSnapshot } from '@shared/ipc';
import type { ExtractionDocument, SentenceExplanation } from '@shared/schema';
import { sha256Hex } from '../cache/hash';
import { bodySentences } from '../chunk/chunker';

/**
 * 해설 표본 검토(COMMIT_PLAN R4.7, PLAN 12.3). 사람이 해설을 읽고 판정을 적는 시트를 만들고, 적은 판정을 센다.
 * 순수 함수다. 화면용 번역 결과(readTranslations)를 재료로 쓴다. 그래서 시트에는 앱 화면과 같은 카드와 링크가 나온다.
 *
 * 표본 뽑기:
 * - 번역이 끝난 본문 문장이 대상이다. 섹션마다 문장 수에 비례해 몫을 나눈다.
 * - 섹션 안에서는 몫의 3분의 2를 개념 카드가 붙은 문장에서 뽑는다. 나머지는 카드 없는 문장에서 뽑는다.
 * - 순서는 씨앗(seed)과 문장 id의 해시로 정한다. 같은 씨앗이면 같은 문장이 나온다.
 *   추출 결과가 같으면 세대가 달라도 같은 문장이 뽑혀 세대끼리 비교할 수 있다.
 *
 * 판정은 시트(Markdown)에 적는다. 표본마다 "판정", "문제 항목", "메모" 세 줄이 있다.
 * 논문과 해설의 글은 인용(>)으로 넣는다. 그래서 글 안의 어떤 줄도 판정 줄로 읽히지 않는다.
 * 같은 개념 카드는 처음 나온 표본에만 전문을 싣는다. 뒤에서는 이름과 그 표본 번호만 적는다.
 */
export const REVIEW_SAMPLE_SIZE = 30;
export const REVIEW_PASS_RATIO = 0.8;
export const REVIEW_DEFAULT_SEED = 'paperlens-review-1';

/** PLAN 12.3의 해설 검토 체크리스트. 번호는 시트의 "문제 항목"에 적는 번호다. */
export const REVIEW_CHECKLIST: readonly string[] = [
  '논문이 말한 사실과 일반적인 배경 설명을 구분했는가',
  '독자가 모를 약어를 다른 약어로 설명하지 않았는가',
  '비유가 조건·범위를 왜곡하지 않았는가',
  '해당 문장을 이해하는 데 필요한 정도의 길이인가',
  '수식이 가려진 부분을 아는 것처럼 설명하지 않았는가',
  '출처를 열었는가뿐 아니라 그 안에 주장에 대한 근거가 실제 있는가',
  '조사에 실패한 개념은 확인 불가로 남겼는가',
];

export interface ReviewSampleItem {
  no: number;
  sentenceId: string;
  sectionId: string;
  sectionTitle: string;
  /** 1부터 세는 쪽 번호 */
  page: number;
  en: string;
  ko: string;
  /** 칸으로 나누기 전 세대의 해설 */
  note: string;
  explanation: SentenceExplanation | null;
  concepts: ConceptCard[];
}

export interface ReviewSample {
  schemaVersion: 1;
  pdfSha256: string;
  title: string | null;
  generationId: string | null;
  seed: string;
  requested: number;
  /** 번역이 끝난 본문 문장 수 */
  candidates: number;
  items: ReviewSampleItem[];
}

interface Candidate {
  order: number;
  item: Omit<ReviewSampleItem, 'no'>;
  rank: string;
}

/** 몫을 큰 나머지 순으로 나눈다. 몫은 그 섹션의 문장 수를 넘지 않는다. */
export function quotasOf(counts: readonly number[], size: number): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0 || size <= 0) return counts.map(() => 0);
  if (size >= total) return [...counts];
  const exact = counts.map((n) => (size * n) / total);
  const quotas = exact.map((x) => Math.floor(x));
  let left = size - quotas.reduce((a, b) => a + b, 0);
  const byRemainder = exact
    .map((x, i) => ({ i, rest: x - Math.floor(x) }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of byRemainder) {
    if (left === 0) break;
    if ((quotas[i] ?? 0) >= (counts[i] ?? 0)) continue;
    quotas[i] = (quotas[i] ?? 0) + 1;
    left -= 1;
  }
  return quotas;
}

export function drawReviewSample(input: {
  document: ExtractionDocument;
  snapshot: TranslationSnapshot;
  size?: number;
  seed?: string;
}): ReviewSample {
  const { document, snapshot } = input;
  const size = Math.max(0, Math.floor(input.size ?? REVIEW_SAMPLE_SIZE));
  const seed = input.seed ?? REVIEW_DEFAULT_SEED;
  const titles = new Map(document.sections.map((s) => [s.id, s.title]));
  const cards = snapshot.concepts ?? {};

  const bySection = new Map<string, Candidate[]>();
  bodySentences(document).forEach(({ sectionId, sentence }, order) => {
    const result = snapshot.results[sentence.id];
    if (!result) return;
    const list = bySection.get(sectionId) ?? [];
    list.push({
      order,
      rank: sha256Hex(`${seed}:${sentence.id}`),
      item: {
        sentenceId: sentence.id,
        sectionId,
        sectionTitle: titles.get(sectionId) ?? '',
        page: sentence.page + 1,
        en: sentence.en,
        ko: result.ko,
        note: result.note,
        explanation: result.explanation ?? null,
        concepts: (result.conceptIds ?? []).flatMap((id) => {
          const card = cards[id];
          return card ? [card] : [];
        }),
      },
    });
    bySection.set(sectionId, list);
  });

  const sections = [...bySection.values()];
  const quotas = quotasOf(
    sections.map((s) => s.length),
    size,
  );
  const picked: Candidate[] = [];
  sections.forEach((candidates, i) => {
    const quota = quotas[i] ?? 0;
    const ranked = [...candidates].sort((a, b) => a.rank.localeCompare(b.rank));
    const withCards = ranked.filter((c) => c.item.concepts.length > 0);
    const plain = ranked.filter((c) => c.item.concepts.length === 0);
    const fromPlain = Math.min(
      quota - Math.min(Math.ceil((quota * 2) / 3), withCards.length),
      plain.length,
    );
    const fromCards = Math.min(quota - fromPlain, withCards.length);
    picked.push(...withCards.slice(0, fromCards), ...plain.slice(0, fromPlain));
  });

  return {
    schemaVersion: 1,
    pdfSha256: snapshot.pdfSha256,
    title: document.paper.title ?? null,
    generationId: snapshot.generationId,
    seed,
    requested: size,
    candidates: sections.reduce((n, s) => n + s.length, 0),
    items: picked.sort((a, b) => a.order - b.order).map((c, i) => ({ no: i + 1, ...c.item })),
  };
}

const quote = (text: string): string =>
  text
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');

const linkLine = (link: ConceptSourceLink, label: string): string => {
  const meta = [label, link.kind, link.language].filter((x) => x !== null && x !== '').join(', ');
  const title = link.title.replace(/[[\]]/g, ' ').trim() || link.url;
  return `> - [${title}](<${link.url}>) (${meta}) ${link.supports}`.trimEnd();
};

const EXPLANATION_FIELDS: readonly (readonly [keyof SentenceExplanation, string])[] = [
  ['main', '해설'],
  ['plain', '쉬운 뜻'],
  ['role', '이 문장의 역할'],
  ['example', '예시'],
  ['caution', '주의할 점'],
  ['deeper', '더 깊이'],
];

export function formatReviewSheet(sample: ReviewSample): string {
  const lines: string[] = [
    '# 해설 표본 검토 시트',
    '',
    `- 논문: ${sample.title ?? '(제목 없음)'}`,
    `- pdfSha256: ${sample.pdfSha256}`,
    `- 세대: ${sample.generationId ?? '(없음)'}`,
    `- 표본: ${String(sample.items.length)}개 (번역이 끝난 본문 문장 ${String(sample.candidates)}개 중, 씨앗 ${sample.seed})`,
    '',
    '적는 법은 `docs/review-checklist.md`에 있다. 표본마다 아래 세 줄의 콜론 뒤에 적는다.',
    '',
    '- 판정: 다른 곳을 검색하지 않고 이 문장의 핵심을 이해했으면 `예`, 아니면 `아니오`.',
    '- 문제 항목: 아래 체크리스트에서 걸린 번호. 없으면 비워 둔다. 예: `2, 6`',
    '- 메모: 자유롭게. 한 줄.',
    '',
    '## 체크리스트',
    '',
    ...REVIEW_CHECKLIST.map((text, i) => `${String(i + 1)}. ${text}`),
    '',
    '## 표본',
    '',
  ];
  const firstShown = new Map<string, number>();
  for (const item of sample.items) {
    lines.push(
      `### 표본 ${String(item.no)}`,
      '',
      `${String(item.page)}쪽 · ${item.sectionTitle || '(섹션 제목 없음)'} · \`${item.sentenceId}\``,
      '',
      '**원문**',
      '',
      quote(item.en),
      '',
      '**번역**',
      '',
      quote(item.ko),
      '',
    );
    if (item.explanation) {
      for (const [key, label] of EXPLANATION_FIELDS) {
        const text = (item.explanation[key] ?? '').trim();
        if (text === '') continue;
        lines.push(`**${label}**`, '', quote(text), '');
      }
    } else if (item.note.trim() !== '') {
      lines.push('**해설**', '', quote(item.note), '');
    } else {
      lines.push('**해설**', '', '> (해설 없음)', '');
    }
    for (const card of item.concepts) {
      const name = card.nameKo ? `${card.nameKo} (${card.name})` : card.name;
      const shownAt = firstShown.get(card.id);
      if (shownAt !== undefined) {
        lines.push(`**개념 카드: ${name}** · 내용은 표본 ${String(shownAt)}에 있다`, '');
        continue;
      }
      firstShown.set(card.id, item.no);
      lines.push(`**개념 카드: ${name}**${card.sourced ? '' : ' · 일반 설명, 출처 미확인'}`, '');
      const body = [
        `뜻: ${card.definitionKo}`,
        card.whyItMatters.trim() === '' ? null : `이 논문에서 중요한 이유: ${card.whyItMatters}`,
        card.exampleKo ? `사례: ${card.exampleKo}` : null,
      ].filter((x): x is string => x !== null);
      lines.push(body.map(quote).join('\n>\n'));
      const links = [
        ...(card.sources ?? []).map((l) => linkLine(l, '읽은 자료')),
        ...(card.further ?? []).map((l) => linkLine(l, '더 볼 자료')),
      ];
      if (links.length > 0) lines.push('>', ...links);
      lines.push('');
    }
    lines.push('- 판정:', '- 문제 항목:', '- 메모:', '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export interface ReviewRecord {
  no: number;
  /** null은 아직 적지 않은 것 */
  understood: boolean | null;
  problems: number[];
  memo: string;
}

export interface ReviewSheetProblem {
  no: number | null;
  detail: string;
}

const YES = new Set(['예', '네', 'o', 'y', 'yes']);
const NO = new Set(['아니오', '아니요', 'x', 'n', 'no']);

export function parseReviewSheet(text: string): {
  records: ReviewRecord[];
  problems: ReviewSheetProblem[];
} {
  const records: ReviewRecord[] = [];
  const problems: ReviewSheetProblem[] = [];
  let current: ReviewRecord | null = null;
  for (const line of text.split(/\r?\n/)) {
    const head = /^### 표본 (\d+)\s*$/.exec(line);
    if (head) {
      const no = Number(head[1]);
      if (records.some((r) => r.no === no)) {
        problems.push({ no, detail: '같은 번호의 표본이 두 번 나온다' });
        current = null;
        continue;
      }
      current = { no, understood: null, problems: [], memo: '' };
      records.push(current);
      continue;
    }
    if (/^## /.test(line)) current = null;
    const field = /^- (판정|문제 항목|메모):(.*)$/.exec(line);
    if (!field || !current) continue;
    const value = (field[2] ?? '').replace(/`/g, '').trim();
    if (field[1] === '메모') {
      current.memo = value;
    } else if (field[1] === '판정') {
      const word = value.toLowerCase();
      if (YES.has(word)) current.understood = true;
      else if (NO.has(word)) current.understood = false;
      else if (word !== '') {
        problems.push({ no: current.no, detail: `판정을 읽을 수 없다: "${value}"` });
      }
    } else {
      for (const part of value.split(/[\s,]+/).filter((p) => p !== '')) {
        const n = Number(part);
        if (Number.isInteger(n) && n >= 1 && n <= REVIEW_CHECKLIST.length) {
          if (!current.problems.includes(n)) current.problems.push(n);
        } else {
          problems.push({ no: current.no, detail: `문제 항목 번호가 아니다: "${part}"` });
        }
      }
    }
  }
  return { records, problems };
}

export interface ReviewSummary {
  total: number;
  reviewed: number;
  understood: number;
  notUnderstood: number;
  unreviewed: number[];
  /** 판정한 표본 가운데 이해한 비율. 판정한 것이 없으면 null */
  ratio: number | null;
  /** 체크리스트 번호(1부터)별로 걸린 표본 수 */
  problemCounts: number[];
  /** 모두 판정했고 이해한 비율이 기준 이상이며 시트에 읽지 못한 줄이 없다 */
  passed: boolean;
}

export function summarizeReview(parsed: {
  records: readonly ReviewRecord[];
  problems: readonly ReviewSheetProblem[];
}): ReviewSummary {
  const { records } = parsed;
  const understood = records.filter((r) => r.understood === true).length;
  const notUnderstood = records.filter((r) => r.understood === false).length;
  const reviewed = understood + notUnderstood;
  const ratio = reviewed === 0 ? null : understood / reviewed;
  return {
    total: records.length,
    reviewed,
    understood,
    notUnderstood,
    unreviewed: records.filter((r) => r.understood === null).map((r) => r.no),
    ratio,
    problemCounts: REVIEW_CHECKLIST.map(
      (_, i) => records.filter((r) => r.problems.includes(i + 1)).length,
    ),
    passed:
      records.length > 0 &&
      reviewed === records.length &&
      parsed.problems.length === 0 &&
      ratio !== null &&
      ratio >= REVIEW_PASS_RATIO,
  };
}

export function formatReviewSummary(
  summary: ReviewSummary,
  parsed: { records: readonly ReviewRecord[]; problems: readonly ReviewSheetProblem[] },
): string[] {
  const percent = summary.ratio === null ? '-' : `${(summary.ratio * 100).toFixed(1)}%`;
  const lines = [
    `표본 ${String(summary.total)}개, 판정 ${String(summary.reviewed)}개, 남은 것 ${String(summary.unreviewed.length)}개`,
    `이해함 ${String(summary.understood)}개, 이해 못 함 ${String(summary.notUnderstood)}개, 비율 ${percent} (기준 ${String(REVIEW_PASS_RATIO * 100)}% 이상)`,
  ];
  if (summary.unreviewed.length > 0) {
    lines.push(`판정하지 않은 표본: ${summary.unreviewed.join(', ')}`);
  }
  summary.problemCounts.forEach((count, i) => {
    if (count > 0)
      lines.push(`문제 항목 ${String(i + 1)} (${REVIEW_CHECKLIST[i] ?? ''}): ${String(count)}개`);
  });
  for (const r of parsed.records) {
    if (r.understood === false || r.problems.length > 0 || r.memo !== '') {
      const verdict = r.understood === null ? '미판정' : r.understood ? '예' : '아니오';
      lines.push(
        `표본 ${String(r.no)}: ${verdict}${r.problems.length > 0 ? `, 항목 ${r.problems.join(', ')}` : ''}${r.memo === '' ? '' : `, ${r.memo}`}`,
      );
    }
  }
  for (const p of parsed.problems) {
    lines.push(`읽지 못한 줄${p.no === null ? '' : ` (표본 ${String(p.no)})`}: ${p.detail}`);
  }
  lines.push(`판정: ${summary.passed ? '통과' : '통과 아님'}`);
  return lines;
}
