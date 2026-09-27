import type { ExtractionDocument, Sentence } from '@shared/schema';
import { sha256Hex, stableStringify } from '../cache/hash';
import { estimateTokens } from '../context/context-input';

/**
 * 섹션·토큰 기준 청크 분할(COMMIT_PLAN C2.4, PLAN 6.3). 순수 함수다.
 * - 단위는 문단이다. 문단을 읽기 순서로 쌓다가 상한을 넘기 직전에 청크를 닫는다.
 * - 하한을 채운 뒤 새 섹션이 시작되면 거기서 닫는다. 작은 섹션은 이웃 섹션과 한 청크에 묶인다.
 * - 상한보다 큰 문단은 문장 경계에서 나눈다. 문장 하나가 상한보다 크면 그 문장만으로 청크를 만든다.
 * - 앞뒤 문맥은 대상 범위 바로 앞과 바로 뒤의 본문 문장이다. 대상에는 들어가지 않는다.
 * 토큰 수는 글자 수 / 4 근사치다. 실제 토크나이저 값이 아니다.
 */
export const CHUNKER_VERSION = '1';

export interface ChunkerOptions {
  /** 이 값을 채운 뒤 섹션이 바뀌면 청크를 닫는다. */
  minTokens: number;
  /** 청크의 대상 문장 토큰 상한. */
  maxTokens: number;
  /** 앞과 뒤에 각각 붙이는 문맥 문장 수. */
  neighborSentences: number;
}

/**
 * 해설을 칸 넷으로 받으면서 출력이 문장당 약 280 토큰으로 늘었다(실측 2026-09-27: 42문장에
 * 출력 11,617 토큰, 5분 53초). 앞선 크기(1,500~2,500)에서는 61문장 청크가 제한 시간에 가까워진다.
 */
export const DEFAULT_CHUNKER_OPTIONS: ChunkerOptions = {
  minTokens: 1_000,
  maxTokens: 1_800,
  neighborSentences: 2,
};

export interface PlannedChunk {
  id: string;
  order: number;
  /** 첫 대상 문장의 섹션. 청크가 여러 섹션에 걸치면 sectionIds에 모두 있다. */
  sectionId: string;
  sectionIds: string[];
  targetSentenceIds: string[];
  /** 읽기 순서. 앞 문맥, 뒤 문맥 순이다. */
  neighborSentenceIds: string[];
  estimatedTokens: number;
  warnings: string[];
}

export interface ChunkPlan {
  chunkerVersion: string;
  options: ChunkerOptions;
  chunks: PlannedChunk[];
  sentenceCount: number;
  estimatedTokens: number;
}

interface Unit {
  sectionId: string;
  sentences: Sentence[];
  tokens: number;
}

const tokensOf = (sentence: Sentence): number => estimateTokens(sentence.en.length);

/** 본문 문장을 읽기 순서로. 섹션 순서가 먼저고 섹션 안에서는 문장 order 순이다. 어느 섹션에도 없는 문장은 빠진다. */
export function bodySentences(document: Pick<ExtractionDocument, 'sections' | 'sentences'>): {
  sectionId: string;
  sentence: Sentence;
}[] {
  const byId = new Map(document.sentences.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const out: { sectionId: string; sentence: Sentence }[] = [];
  for (const section of [...document.sections].sort((a, b) => a.order - b.order)) {
    const sentences = section.sentenceIds
      .map((id) => byId.get(id))
      .filter((s): s is Sentence => s !== undefined)
      .sort((a, b) => a.order - b.order);
    for (const sentence of sentences) {
      if (seen.has(sentence.id)) continue;
      seen.add(sentence.id);
      out.push({ sectionId: section.id, sentence });
    }
  }
  return out;
}

function unitsOf(body: { sectionId: string; sentence: Sentence }[], maxTokens: number): Unit[] {
  const paragraphs: Unit[] = [];
  for (const { sectionId, sentence } of body) {
    const last = paragraphs.at(-1);
    const first = last?.sentences[0];
    if (
      last &&
      first &&
      last.sectionId === sectionId &&
      first.paragraphId === sentence.paragraphId
    ) {
      last.sentences.push(sentence);
      last.tokens += tokensOf(sentence);
    } else {
      paragraphs.push({ sectionId, sentences: [sentence], tokens: tokensOf(sentence) });
    }
  }
  const units: Unit[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.tokens <= maxTokens) {
      units.push(paragraph);
      continue;
    }
    let piece: Unit = { sectionId: paragraph.sectionId, sentences: [], tokens: 0 };
    for (const sentence of paragraph.sentences) {
      const t = tokensOf(sentence);
      if (piece.sentences.length > 0 && piece.tokens + t > maxTokens) {
        units.push(piece);
        piece = { sectionId: paragraph.sectionId, sentences: [], tokens: 0 };
      }
      piece.sentences.push(sentence);
      piece.tokens += t;
    }
    if (piece.sentences.length > 0) units.push(piece);
  }
  return units;
}

export function planChunks(
  document: Pick<ExtractionDocument, 'sections' | 'sentences'>,
  options: Partial<ChunkerOptions> = {},
): ChunkPlan {
  const opts: ChunkerOptions = { ...DEFAULT_CHUNKER_OPTIONS, ...options };
  if (opts.maxTokens < 1 || opts.minTokens < 0 || opts.minTokens > opts.maxTokens) {
    throw new Error(`청크 크기 설정이 잘못됐습니다: min=${opts.minTokens} max=${opts.maxTokens}`);
  }
  if (opts.neighborSentences < 0) throw new Error('문맥 문장 수는 0 이상이어야 합니다');

  const body = bodySentences(document);
  const position = new Map(body.map((b, i) => [b.sentence.id, i]));
  const groups: Unit[][] = [];
  let current: Unit[] = [];
  let tokens = 0;
  const close = (): void => {
    if (current.length > 0) groups.push(current);
    current = [];
    tokens = 0;
  };
  for (const unit of unitsOf(body, opts.maxTokens)) {
    const last = current.at(-1);
    if (last) {
      const overflow = tokens + unit.tokens > opts.maxTokens;
      const sectionBreak = tokens >= opts.minTokens && unit.sectionId !== last.sectionId;
      if (overflow || sectionBreak) close();
    }
    current.push(unit);
    tokens += unit.tokens;
  }
  close();

  const width = Math.max(4, String(groups.length).length);
  const chunks: PlannedChunk[] = groups.map((group, index) => {
    const sentences = group.flatMap((u) => u.sentences);
    const targetIds = sentences.map((s) => s.id);
    const first = position.get(targetIds[0] ?? '') ?? 0;
    const lastIndex = position.get(targetIds.at(-1) ?? '') ?? first;
    const before = body.slice(Math.max(0, first - opts.neighborSentences), first);
    const after = body.slice(lastIndex + 1, lastIndex + 1 + opts.neighborSentences);
    const estimated = group.reduce((n, u) => n + u.tokens, 0);
    const warnings: string[] = [];
    if (estimated > opts.maxTokens) {
      warnings.push(`문장 하나가 상한 ${opts.maxTokens} 토큰보다 큽니다(약 ${estimated})`);
    }
    const sectionIds = [...new Set(group.map((u) => u.sectionId))];
    return {
      id: `chunk_${String(index + 1).padStart(width, '0')}`,
      order: index,
      sectionId: sectionIds[0] ?? '',
      sectionIds,
      targetSentenceIds: targetIds,
      neighborSentenceIds: [...before, ...after].map((b) => b.sentence.id),
      estimatedTokens: estimated,
      warnings,
    };
  });
  return {
    chunkerVersion: CHUNKER_VERSION,
    options: opts,
    chunks,
    sentenceCount: body.length,
    estimatedTokens: chunks.reduce((n, c) => n + c.estimatedTokens, 0),
  };
}

export interface ChunkInputVersions {
  /** 청크 프롬프트 템플릿의 promptVersion */
  promptVersion: string;
  contextVersion: number;
  /** context.json 파일의 sha256. 같은 버전 번호라도 내용이 다르면 다시 요청해야 한다. */
  contextSha256: string;
}

/**
 * 청크 입력의 해시. 대상·문맥 문장의 id와 글, 프롬프트·컨텍스트 버전이 같으면 같은 값이다.
 * 저장된 결과의 inputHash와 다르면 그 결과는 지금 입력의 결과가 아니다(PLAN 8.3).
 */
export function chunkInputHash(
  chunk: Pick<PlannedChunk, 'targetSentenceIds' | 'neighborSentenceIds'>,
  sentences: ReadonlyMap<string, Pick<Sentence, 'id' | 'en'>>,
  versions: ChunkInputVersions,
): string {
  const pick = (id: string): { id: string; en: string } => {
    const sentence = sentences.get(id);
    if (!sentence) throw new Error(`청크가 문서에 없는 문장을 가리킵니다: ${id}`);
    return { id: sentence.id, en: sentence.en };
  };
  return sha256Hex(
    stableStringify({
      chunker: CHUNKER_VERSION,
      targets: chunk.targetSentenceIds.map(pick),
      neighbors: chunk.neighborSentenceIds.map(pick),
      versions,
    }),
  );
}
