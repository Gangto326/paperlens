import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExtractionDocument, Section, Sentence, Usage } from '@shared/schema';
import { sampleExtraction } from '@shared/schema/fixtures';
import { PaperCacheStore } from '../cache/paper-cache-store';
import type { LlmJobFailureKind, LlmJobRequest, LlmJobResult, LlmJobRunner } from '../llm/job';
import { INPUT_PREAMBLE, promptVersionOf } from '../prompt/template';
import {
  CONTEXT_DIGEST_TEMPLATE,
  CONTEXT_MERGE_TEMPLATE,
  CONTEXT_NO_TOOLS_TEMPLATE,
} from '../prompt/templates';
import { buildChunkInputs } from '../translate/chunk-input';
import { buildAliases } from '../prompt/aliases';
import { planParts, type DigestModelOutput } from './context-digest';
import { buildContextInput, type ContextBodySection } from './context-input';
import type { ContextMergeModelOutput } from './context-output';
import { contextPromptVersionOf, pendingGenerationOf, runContextPass } from './context-pass';

/** 긴 논문의 계층형 1차 패스(COMMIT_PLAN C3.1). */
const SHA = 'b'.repeat(64);
const REV = 'rlong';
const NOW = new Date('2026-09-30T02:00:00.000Z');
const USAGE: Usage = {
  logicalJobs: 1,
  turnCount: 1,
  reportedModelCalls: null,
  inputTokens: 100,
  cachedInputTokens: 0,
  outputTokens: 10,
  reasoningTokens: 0,
  elapsedMs: 5,
};

/** 섹션 4개. 섹션마다 문장 3개, 문장 하나는 100토큰(400자)이다. 셋째 섹션만 문장이 5개다. */
const makeDocument = (): ExtractionDocument => {
  const sections: Section[] = [];
  const sentences: Sentence[] = [];
  for (let i = 0; i < 4; i += 1) {
    const ids: string[] = [];
    for (let k = 0; k < (i === 2 ? 5 : 3); k += 1) {
      const id = `id_${i}_${k}`;
      ids.push(id);
      const en = `Sentence ${i}.${k} `.padEnd(400, 'x');
      sentences.push({
        id,
        order: sentences.length,
        page: 0,
        pages: [0],
        sectionId: `sec_${i}`,
        paragraphId: `p_${i}`,
        kind: 'sentence',
        enRaw: en,
        en,
        sourceSpans: [],
        rects: [],
        mappingStatus: 'mapped',
        equations: [],
        citationMarkers: [],
        warnings: [],
      });
    }
    sections.push({ id: `sec_${i}`, title: `Section ${i}`, order: i, sentenceIds: ids });
  }
  return { ...sampleExtraction, sections, sentences };
};

let root: string;
let store: PaperCacheStore;
let document: ExtractionDocument;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'paperlens-hierarchy-'));
  store = new PaperCacheStore(root);
  await store.initPaper(SHA, NOW);
  document = makeDocument();
  const path = store.extractionPath(SHA, REV, 'document.json');
  const sha = await store.writeJson('extractionDocument', path, document);
  await store.updateManifest(SHA, (m) => {
    store.recordFile(m, SHA, path, sha);
    m.currentExtractionRevision = REV;
    m.state = 'mapping';
  });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const dataOf = (request: LlmJobRequest): Record<string, unknown> =>
  JSON.parse(request.prompt.slice(INPUT_PREAMBLE.length + 1)) as Record<string, unknown>;
const isPart = (request: LlmJobRequest): boolean => /_part_\d+$/.test(request.jobId);
const partOf = (request: LlmJobRequest): ContextBodySection[] =>
  dataOf(request)['PAPER_PART'] as ContextBodySection[];

const digestOf = (body: ContextBodySection[]): DigestModelOutput => ({
  digests: body.map((s) => ({
    sectionId: s.id,
    summary: ` ${s.title}의 요약 `,
    claims: [`${s.title}의 주장`, ' '],
    termCandidates: ['retriever: 문서를 찾는 모듈'],
    evidenceSentenceIds: [s.sentences[0]?.id ?? '', 's999'],
    unresolved: [],
  })),
  coverage: body.map((s) => ({
    sectionId: s.id,
    startSentenceId: s.sentences[0]?.id ?? '',
    endSentenceId: s.sentences.at(-1)?.id ?? '',
    status: 'covered',
  })),
});
const merged = (): ContextMergeModelOutput => ({
  summary: '긴 논문의 요약.',
  researchQuestion: '문제',
  contributions: ['기여'],
  methodOverview: '방법',
  mainResults: [],
  limitations: [],
  glossary: [
    {
      term: 'retriever',
      aliases: [],
      preferredKo: '검색기',
      acceptedKo: ['리트리버'],
      displayRule: '',
      meaningInPaper: '문서를 찾는 모듈',
      evidenceSentenceIds: ['s1'],
    },
  ],
  concepts: [],
  unresolved: [],
});

type Rule = (request: LlmJobRequest) => LlmJobFailureKind | DigestModelOutput | null;
/** `hold`를 주면 부분 작업 요청을 그 수만큼 모일 때까지 붙잡아 둔다. 동시에 도는지 보려는 것이다. */
const runnerOf = (
  rule: Rule = () => null,
  hold = 0,
): LlmJobRunner & { requests: LlmJobRequest[]; peak: () => number } => {
  const requests: LlmJobRequest[] = [];
  let open = 0;
  let peak = 0;
  let release: () => void = () => undefined;
  const gathered = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    requests,
    peak: () => peak,
    run: async (request) => {
      requests.push(request);
      open += 1;
      peak = Math.max(peak, open);
      if (hold > 0 && isPart(request)) {
        if (open >= hold) release();
        await Promise.race([gathered, new Promise((r) => setTimeout(r, 3_000))]);
      }
      await new Promise((r) => setTimeout(r, 1));
      open -= 1;
      const verdict = rule(request);
      if (typeof verdict === 'string') {
        const failed: LlmJobResult = {
          ok: false,
          jobId: request.jobId,
          kind: verdict,
          message: `실패 ${verdict}`,
          errors: [],
          rawText: null,
          model: null,
          usage: USAGE,
        };
        return failed;
      }
      const value = verdict ?? (isPart(request) ? digestOf(partOf(request)) : merged());
      return {
        ok: true,
        jobId: request.jobId,
        value,
        rawText: JSON.stringify(value),
        model: 'fake-model',
        usage: USAGE,
      };
    },
    cancel: (jobId) => Promise.resolve({ jobId, status: 'not_found' }),
    activeJobIds: () => [],
  };
};

// 본문 1,400토큰. 한 번에 읽는 상한을 1,000으로, 한 부분의 상한을 500으로 둔다.
const run = (
  runner: LlmJobRunner,
  over: Partial<Parameters<typeof runContextPass>[1]> = {},
): ReturnType<typeof runContextPass> =>
  runContextPass(
    { store, runner, provider: 'codex', runtimeVersion: '0.157.1', now: () => NOW },
    { pdfSha256: SHA, maxInputTokens: 1_000, partMaxTokens: 500, ...over },
  );
const pendingFiles = async (): Promise<string[]> => {
  try {
    return (await fs.readdir(store.inflightDir(SHA, pendingGenerationOf(REV)))).sort();
  } catch {
    return [];
  }
};

describe('planParts', () => {
  it('읽기 순서로 담고, 긴 섹션은 문장 경계에서 나눈다. 빠지는 문장이 없다', () => {
    const input = buildContextInput(document);
    const parts = planParts(input, 500);
    expect(parts.map((p) => [p.id, p.estimatedTokens])).toEqual([
      ['part_001', 500],
      ['part_002', 500],
      ['part_003', 400],
    ]);
    expect(parts.map((p) => p.sections.map((s) => [s.sectionId, s.sentenceIds.length]))).toEqual([
      [
        ['sec_0', 3],
        ['sec_1', 2],
      ],
      [
        ['sec_1', 1],
        ['sec_2', 4],
      ],
      [
        ['sec_2', 1],
        ['sec_3', 3],
      ],
    ]);
    expect(parts.flatMap((p) => p.sections.flatMap((s) => s.sentenceIds))).toEqual(
      document.sentences.map((s) => s.id),
    );
    // 자료에는 별칭만 나간다.
    expect(parts[1]?.body.map((s) => [s.id, s.sentences.map((x) => x.id)])).toEqual([
      ['sec2', ['s6']],
      ['sec3', ['s7', 's8', 's9', 's10']],
    ]);
  });

  it('문장 하나가 상한보다 길어도 그 문장 하나로 한 부분을 만든다', () => {
    const parts = planParts(buildContextInput(document), 50);
    expect(parts).toHaveLength(document.sentences.length);
    expect(parts.every((p) => p.estimatedTokens === 100)).toBe(true);
  });
});

describe('runContextPass 긴 논문', () => {
  it('기본 설정은 5개를 넘는 모든 부분을 동시에 읽고 나서 통합한다', async () => {
    const count = document.sentences.length;
    const runner = runnerOf(() => null, count);
    const result = await run(runner, { partMaxTokens: 100 });
    if (!result.ok) throw new Error(result.message);
    expect(count).toBeGreaterThan(5);
    expect(runner.peak()).toBe(count);
    expect(runner.requests.slice(0, count).every(isPart)).toBe(true);
    expect(runner.requests).toHaveLength(count + 1);
    expect(isPart(runner.requests[count]!)).toBe(false);
    expect(await store.verifyFiles(SHA)).toEqual([]);
  });

  it('부분 작업을 동시에 돌리고 통합 턴으로 컨텍스트를 만든다. coverage에 빠진 문장이 없다', async () => {
    const runner = runnerOf(() => null, 3);
    const result = await run(runner, { concurrency: 3 });
    if (!result.ok) throw new Error(result.message);
    expect(runner.peak()).toBe(3);
    // 부분 작업이 실행기에 닿는 순서는 정해져 있지 않다. 통합 턴은 모든 부분이 끝난 뒤에 간다.
    expect(
      runner.requests
        .slice(0, 3)
        .map((r) => r.jobId.replace(/^.*?(part_\d+)$/, '$1'))
        .sort(),
    ).toEqual(['part_001', 'part_002', 'part_003']);
    const part = runner.requests.find((r) => r.jobId.endsWith('part_001'));
    const merge = runner.requests[3];
    expect(isPart(merge as LlmJobRequest)).toBe(false);
    expect(part).toMatchObject({ research: { kind: 'none' } });
    expect(part?.instructions).toBe(CONTEXT_DIGEST_TEMPLATE.instructions);
    expect(dataOf(part as LlmJobRequest)['PAPER_OUTLINE']).toMatchObject({
      part: 1,
      parts: 3,
      partSections: ['Section 0', 'Section 1'],
      sections: [
        { title: 'Section 0' },
        { title: 'Section 1' },
        { title: 'Section 2' },
        { title: 'Section 3' },
      ],
    });
    // 통합 턴에는 본문이 없고 섹션 요약만 있다.
    expect(merge?.instructions).toBe(CONTEXT_MERGE_TEMPLATE.instructions);
    const mergeData = dataOf(merge as LlmJobRequest);
    expect(Object.keys(mergeData)).toEqual(['PAPER_METADATA', 'SECTION_DIGESTS']);
    expect(merge?.prompt).not.toContain('Sentence 0.0');
    expect(mergeData['SECTION_DIGESTS']).toMatchObject([
      { sectionId: 'sec1', title: 'Section 0', summary: 'Section 0의 요약' },
      { sectionId: 'sec2', evidenceSentenceIds: ['s4'] },
      { sectionId: 'sec2', evidenceSentenceIds: ['s6'] },
      { sectionId: 'sec3' },
      { sectionId: 'sec3' },
      { sectionId: 'sec4' },
    ]);
    expect((merge?.outputSchema as { required: string[] }).required).not.toContain('coverage');

    const { context } = result;
    expect(context.promptVersion).toBe(
      `${promptVersionOf(CONTEXT_MERGE_TEMPLATE)}+${promptVersionOf(CONTEXT_DIGEST_TEMPLATE)}`,
    );
    expect(context.sectionDigests.map((d) => d.sectionId)).toEqual([
      'sec_0',
      'sec_1',
      'sec_1',
      'sec_2',
      'sec_2',
      'sec_3',
    ]);
    expect(context.sectionDigests[0]).toEqual({
      sectionId: 'sec_0',
      summary: 'Section 0의 요약',
      claims: ['Section 0의 주장'],
      termCandidates: ['retriever: 문서를 찾는 모듈'],
      evidenceSentenceIds: ['id_0_0'],
      unresolved: [],
    });
    // 모든 문장이 어느 부분 작업의 coverage에 들어 있다.
    const covered = new Set<string>();
    for (const c of context.coverage) {
      expect(c.status).toBe('covered');
      expect(c.jobId).toMatch(/_part_00[123]$/);
      const ids = document.sections.find((s) => s.id === c.sectionId)?.sentenceIds ?? [];
      for (const id of ids.slice(
        ids.indexOf(c.startSentenceId),
        ids.indexOf(c.endSentenceId) + 1,
      )) {
        covered.add(id);
      }
    }
    expect([...covered].sort()).toEqual(document.sentences.map((s) => s.id).sort());
    expect(result.parts.map((p) => [p.partId, p.outcome, p.sentences])).toEqual([
      ['part_001', 'ok', 5],
      ['part_002', 'ok', 5],
      ['part_003', 'ok', 4],
    ]);
    expect(result.notes.filter((n) => n.includes('s999'))).toHaveLength(6);

    const manifest = await store.readManifest(SHA);
    expect(manifest.state).toBe('context_pending');
    expect(manifest.usage).toMatchObject({ logicalJobs: 4, inputTokens: 400 });
    expect(manifest.generations.at(-1)?.promptVersion).toBe(context.promptVersion);
    expect(await store.verifyFiles(SHA)).toEqual([]);
    expect(await pendingFiles()).toEqual([]);
  });

  it('본문이 상한보다 짧으면 한 번에 읽는다', async () => {
    const runner = runnerOf(() => null);
    const input = buildContextInput(document);
    expect(contextPromptVersionOf(input.estimatedTokens, 1_000)).not.toBe(
      contextPromptVersionOf(input.estimatedTokens, 1_400),
    );
    expect(contextPromptVersionOf(input.estimatedTokens)).toBe(
      promptVersionOf(CONTEXT_NO_TOOLS_TEMPLATE),
    );
    const single = await run(
      {
        ...runner,
        run: (request) => {
          runner.requests.push(request);
          expect(request.instructions).toBe(CONTEXT_NO_TOOLS_TEMPLATE.instructions);
          const body = dataOf(request)['PAPER_BODY'] as ContextBodySection[];
          const value = { ...merged(), coverage: digestOf(body).coverage };
          return Promise.resolve({
            ok: true,
            jobId: request.jobId,
            value,
            rawText: JSON.stringify(value),
            model: null,
            usage: USAGE,
          });
        },
      },
      { maxInputTokens: 1_400 },
    );
    expect(single).toMatchObject({ ok: true, parts: [] });
    expect(runner.requests).toHaveLength(1);
    if (single.ok) expect(single.context.sectionDigests).toEqual([]);
    expect(await pendingFiles()).toEqual([]);
  });

  it('부분 하나가 문장을 빠뜨리면 통합 턴을 보내지 않고 실패를 기록한다', async () => {
    const runner = runnerOf((request) => {
      if (!isPart(request) || !request.jobId.endsWith('part_002')) return null;
      const good = digestOf(partOf(request));
      return {
        ...good,
        coverage: good.coverage.map((c) =>
          c.sectionId === 'sec3' ? { ...c, endSentenceId: 's9' } : c,
        ),
      };
    });
    const result = await run(runner);
    expect(result).toMatchObject({
      ok: false,
      code: 'validation_failed',
      llmKind: null,
      state: 'context_pending',
      problems: [{ code: 'sentences_not_covered' }],
    });
    expect(result.parts.map((p) => p.outcome)).toEqual(['ok', 'validation_failed', 'ok']);
    expect(runner.requests.filter((r) => !isPart(r))).toEqual([]);
    const manifest = await store.readManifest(SHA);
    expect(manifest.errors.map((e) => [e.stage, e.code])).toEqual([
      ['context', 'context_part_validation_failed'],
    ]);
    expect(manifest.currentGenerationId).toBeNull();
  });

  it('섹션의 요약이 없는 부분은 통과하지 못한다', async () => {
    const runner = runnerOf((request) => {
      if (!isPart(request) || !request.jobId.endsWith('part_001')) return null;
      const good = digestOf(partOf(request));
      return { ...good, digests: good.digests.slice(0, 1) };
    });
    const result = await run(runner);
    expect(result).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(result.ok ? '' : result.message).toContain('섹션 sec2의 요약이 없습니다');
  });

  it('한도로 멈춘 뒤 다시 실행하면 끝난 부분은 다시 요청하지 않는다', async () => {
    const limited = runnerOf((request) => (request.jobId.endsWith('part_002') ? 'quota' : null));
    const stopped = await run(limited, { concurrency: 1 });
    expect(stopped).toMatchObject({
      ok: false,
      code: 'llm_failed',
      llmKind: 'quota',
      state: 'waiting_quota',
    });
    // 한도에 걸린 뒤에는 새 부분을 보내지 않는다.
    expect(limited.requests.map((r) => r.jobId.slice(-8))).toEqual(['part_001', 'part_002']);
    expect(stopped.parts.map((p) => p.outcome)).toEqual(['ok', 'llm_failed', 'not_sent']);
    expect((await pendingFiles()).filter((n) => n.endsWith('.txt'))).toHaveLength(2);

    const runner = runnerOf();
    const result = await run(runner, { concurrency: 1 });
    if (!result.ok) throw new Error(result.message);
    expect(runner.requests.map((r) => r.jobId.replace(/^.*?(part_\d+|Z)$/, '$1'))).toEqual([
      'part_002',
      'part_003',
      'Z',
    ]);
    expect(result.parts.map((p) => p.outcome)).toEqual(['reused', 'ok', 'ok']);
    expect(result.context.sectionDigests).toHaveLength(6);
    expect(result.context.coverage.map((c) => c.jobId.slice(-8))).toEqual([
      'part_001',
      'part_001',
      'part_002',
      'part_002',
      'part_003',
      'part_003',
    ]);
    expect(await pendingFiles()).toEqual([]);
    expect(await store.verifyFiles(SHA)).toEqual([]);
  });

  it('통합 턴이 로그인 문제로 끝나면 다시 실행할 때 부분을 하나도 다시 요청하지 않는다', async () => {
    const first = runnerOf((request) => (isPart(request) ? null : 'needs_login'));
    expect(await run(first)).toMatchObject({
      ok: false,
      llmKind: 'needs_login',
      state: 'needs_login',
    });
    const runner = runnerOf();
    const result = await run(runner);
    expect(result).toMatchObject({ ok: true });
    expect(runner.requests.map(isPart)).toEqual([false]);
    expect(result.parts.map((p) => p.outcome)).toEqual(['reused', 'reused', 'reused']);
  });

  it('남은 출력도 다시 검증한다. 통과하지 못하면 그 부분을 다시 요청한다', async () => {
    const limited = runnerOf((request) => (isPart(request) ? null : 'quota'));
    await run(limited);
    const dir = store.inflightDir(SHA, pendingGenerationOf(REV));
    const name = (await fs.readdir(dir)).find((n) => n.endsWith('part_001.txt')) ?? '';
    const saved = JSON.parse(await fs.readFile(join(dir, name), 'utf8')) as DigestModelOutput;
    await fs.writeFile(join(dir, name), JSON.stringify({ ...saved, coverage: [] }));
    const runner = runnerOf();
    const result = await run(runner);
    expect(result).toMatchObject({ ok: true });
    expect(runner.requests.map((r) => r.jobId.replace(/^.*?(part_\d+|Z)$/, '$1'))).toEqual([
      'part_001',
      'Z',
    ]);
  });
});

describe('긴 논문의 컨텍스트로 만든 청크 입력', () => {
  it('섹션 요약이 있으면 그 섹션의 요약을 넣는다. 없으면 앞서와 같다', async () => {
    const result = await run(runnerOf());
    if (!result.ok) throw new Error(result.message);
    const chunk = {
      id: 'chunk_0001',
      order: 0,
      sectionId: 'sec_1',
      sectionIds: ['sec_1', 'sec_3'],
      targetSentenceIds: ['id_1_0'],
      neighborSentenceIds: [],
      estimatedTokens: 100,
      warnings: [],
    };
    const aliases = buildAliases(document);
    expect(buildChunkInputs(document, result.context, chunk, aliases).SECTION_CONTEXT).toEqual([
      { title: 'Section 1', parent: null, summary: 'Section 1의 요약\n\nSection 1의 요약' },
      { title: 'Section 3', parent: null, summary: 'Section 3의 요약' },
    ]);
    const plain = { ...result.context, sectionDigests: [] };
    expect(buildChunkInputs(document, plain, chunk, aliases).SECTION_CONTEXT).toEqual([
      { title: 'Section 1', parent: null },
      { title: 'Section 3', parent: null },
    ]);
  });
});
