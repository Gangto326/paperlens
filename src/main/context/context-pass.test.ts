import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Usage } from '@shared/schema';
import { PaperCacheStore } from '../cache/paper-cache-store';
import {
  TINY_SHA,
  TINY_TEI,
  tinyFonts,
  tinyItems,
  tinyPages,
} from '../extract/__fixtures__/tiny-paper';
import { buildAndSaveDocument } from '../extract/document-store';
import { saveTextItems } from '../extract/text-items-store';
import type { LlmJobFailureKind, LlmJobRequest, LlmJobResult, LlmJobRunner } from '../llm/job';
import { saveOriginalTei } from '../parser/grobid-fulltext';
import { INPUT_PREAMBLE } from '../prompt/template';
import { buildContextInput, type ContextBodySection } from './context-input';
import { CONTEXT_OUTPUT_SCHEMA, type ContextModelOutput } from './context-output';
import { runContextPass } from './context-pass';
import { validateContextOutput } from './context-validate';

let root: string;
let store: PaperCacheStore;
const NOW = new Date('2026-09-27T10:00:00.000Z');
const USAGE: Usage = {
  logicalJobs: 1,
  turnCount: 1,
  reportedModelCalls: null,
  inputTokens: 900,
  cachedInputTokens: 0,
  outputTokens: 120,
  reasoningTokens: 30,
  elapsedMs: 50,
};

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'paperlens-context-'));
  store = new PaperCacheStore(root);
  await store.initPaper(TINY_SHA, NOW);
  const r = await saveTextItems(
    store,
    {
      pdfSha256: TINY_SHA,
      pdfjsVersion: '6.3.289',
      textExtractorVersion: '2',
      pages: tinyPages(),
      textItems: tinyItems(),
      fonts: tinyFonts(),
    },
    { parserConfigHash: 'cfg0', now: NOW },
  );
  await saveOriginalTei(store, TINY_SHA, r.extractionRevision, TINY_TEI);
  await buildAndSaveDocument(store, TINY_SHA, {
    fileName: 'tiny.pdf',
    pages: tinyPages(),
    parserVersion: '0.9.1',
    parserConfigHash: 'cfg0',
    now: NOW,
  });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const bodyOf = (request: LlmJobRequest): ContextBodySection[] => {
  const data = JSON.parse(request.prompt.slice(INPUT_PREAMBLE.length + 1)) as {
    PAPER_BODY: ContextBodySection[];
  };
  return data.PAPER_BODY;
};

/** 입력을 모두 덮는 정상 출력. */
const goodOutput = (body: ContextBodySection[]): ContextModelOutput => ({
  summary: '작은 논문의 요약.',
  researchQuestion: '무엇을 푸는가.',
  contributions: ['기여 1'],
  methodOverview: '방법.',
  mainResults: ['결과 1'],
  limitations: [],
  glossary: [
    {
      term: 'retrieval',
      aliases: ['IR'],
      preferredKo: '검색',
      displayRule: '첫 등장에 원어 병기',
      meaningInPaper: '문서를 찾아오는 단계',
      evidenceSentenceIds: [body[0]?.sentences[0]?.id ?? 's1'],
    },
  ],
  unresolved: ['dense retrieval의 배경'],
  coverage: body.map((s) => ({
    sectionId: s.id,
    startSentenceId: s.sentences[0]?.id ?? '',
    endSentenceId: s.sentences.at(-1)?.id ?? '',
    status: 'covered',
  })),
});

const runnerOf = (
  reply: (request: LlmJobRequest) => LlmJobResult,
): LlmJobRunner & { requests: LlmJobRequest[] } => {
  const requests: LlmJobRequest[] = [];
  return {
    requests,
    run: (request) => {
      requests.push(request);
      return Promise.resolve(reply(request));
    },
    cancel: (jobId) => Promise.resolve({ jobId, status: 'not_found' }),
    activeJobIds: () => [],
  };
};

const okWith =
  (make: (body: ContextBodySection[]) => unknown) =>
  (request: LlmJobRequest): LlmJobResult => {
    const value = make(bodyOf(request));
    return {
      ok: true,
      jobId: request.jobId,
      value,
      rawText: JSON.stringify(value),
      model: 'fake-model',
      usage: USAGE,
    };
  };

const failWith =
  (kind: LlmJobFailureKind) =>
  (request: LlmJobRequest): LlmJobResult => ({
    ok: false,
    jobId: request.jobId,
    kind,
    message: `실패 ${kind}`,
    errors: [],
    rawText: null,
    model: null,
    usage: { ...USAGE, inputTokens: null, outputTokens: null, reasoningTokens: null },
  });

const deps = (runner: LlmJobRunner) => ({
  store,
  runner,
  provider: 'codex',
  runtimeVersion: '0.157.1',
  now: () => NOW,
});

describe('runContextPass', () => {
  it('검증을 통과하면 context.json을 저장하고 manifest에 세대·해시·사용량을 기록한다', async () => {
    const runner = runnerOf(okWith(goodOutput));
    const result = await runContextPass(deps(runner), { pdfSha256: TINY_SHA });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.generationId).toBe('gen_20260927T100000Z');
    expect(result.state).toBe('context_pending');
    const saved = await store.readJson('contextDocument', result.contextPath);
    expect(saved).toEqual(result.context);
    expect(saved.glossary).toHaveLength(1);
    expect(saved.glossary[0]).toMatchObject({ id: 'g_1', term: 'retrieval', conceptIds: [] });
    expect(saved.concepts).toEqual([]);
    expect(saved.unresolved).toEqual(['dense retrieval의 배경']);
    expect(saved.promptVersion).toMatch(/^context\.no_tools@[0-9a-f]{12}$/);

    // 캐시에는 별칭이 아니라 원래 ID가 들어간다.
    const manifest = await store.readManifest(TINY_SHA);
    const rev = manifest.currentExtractionRevision ?? '';
    const document = await store.readJson(
      'extractionDocument',
      store.extractionPath(TINY_SHA, rev, 'document.json'),
    );
    const sentenceIds = new Set(document.sentences.map((s) => s.id));
    const sectionIds = new Set(document.sections.map((s) => s.id));
    for (const c of saved.coverage) {
      expect(sectionIds.has(c.sectionId)).toBe(true);
      expect(sentenceIds.has(c.startSentenceId)).toBe(true);
      expect(sentenceIds.has(c.endSentenceId)).toBe(true);
      expect(c.jobId).toBe(result.jobId);
    }
    for (const id of saved.glossary[0]?.evidenceSentenceIds ?? []) {
      expect(sentenceIds.has(id)).toBe(true);
    }

    expect(manifest.currentGenerationId).toBe(result.generationId);
    expect(manifest.generations).toEqual([
      {
        generationId: result.generationId,
        extractionRevision: rev,
        promptVersion: saved.promptVersion,
        contextVersion: 1,
        provider: 'codex',
        runtimeVersion: '0.157.1',
        modelId: 'fake-model',
        createdAt: NOW.toISOString(),
      },
    ]);
    expect(manifest.usage).toMatchObject({ logicalJobs: 1, turnCount: 1, inputTokens: 900 });
    expect(manifest.errors).toEqual([]);
    expect(await store.verifyFiles(TINY_SHA)).toEqual([]);
  });

  it('요청은 도구 없는 정책·역할 지침·출력 스키마를 담고, 자료에는 짧은 별칭만 나간다', async () => {
    const runner = runnerOf(okWith(goodOutput));
    await runContextPass(deps(runner), { pdfSha256: TINY_SHA, jobId: 'ctx-1' });
    const request = runner.requests[0];
    expect(request).toMatchObject({
      jobId: 'ctx-1',
      research: { kind: 'none' },
      outputSchema: CONTEXT_OUTPUT_SCHEMA,
    });
    expect(request?.instructions).toContain('이 턴에는 검색 도구가 없다');
    const body = request ? bodyOf(request) : [];
    expect(body.length).toBeGreaterThan(0);
    for (const section of body) {
      expect(section.id).toMatch(/^sec\d+$/);
      expect(section.sentences.length).toBeGreaterThan(0);
      for (const s of section.sentences) expect(s.id).toMatch(/^s\d+$/);
    }
  });

  it('coverage가 섹션 하나를 빠뜨리면 저장하지 않고 실패를 기록한다', async () => {
    const runner = runnerOf(
      okWith((body) => ({ ...goodOutput(body), coverage: goodOutput(body).coverage.slice(1) })),
    );
    const result = await runContextPass(deps(runner), { pdfSha256: TINY_SHA });
    expect(result).toMatchObject({
      ok: false,
      code: 'validation_failed',
      state: 'context_pending',
    });
    if (result.ok) return;
    expect(result.problems.map((p) => p.code)).toContain('section_not_covered');
    expect(result.rawText).not.toBeNull();
    const manifest = await store.readManifest(TINY_SHA);
    expect(manifest.generations).toEqual([]);
    expect(manifest.currentGenerationId).toBeNull();
    expect(manifest.errors).toHaveLength(1);
    expect(manifest.errors[0]).toMatchObject({
      stage: 'context',
      code: 'context_validation',
      retryable: true,
    });
    // 실패한 작업도 한도를 썼다.
    expect(manifest.usage).toMatchObject({ logicalJobs: 1, inputTokens: 900 });
    expect(
      await store.exists(store.generationPath(TINY_SHA, 'gen_20260927T100000Z', 'context.json')),
    ).toBe(false);
  });

  it('로그인 필요·한도 초과는 상태를 바꾸고, 그 상태에서 다시 시작할 수 있다', async () => {
    const login = await runContextPass(deps(runnerOf(failWith('needs_login'))), {
      pdfSha256: TINY_SHA,
    });
    expect(login).toMatchObject({
      ok: false,
      code: 'llm_failed',
      llmKind: 'needs_login',
      state: 'needs_login',
    });
    const quota = await runContextPass(deps(runnerOf(failWith('quota'))), { pdfSha256: TINY_SHA });
    expect(quota).toMatchObject({ ok: false, llmKind: 'quota', state: 'waiting_quota' });
    const timeout = await runContextPass(deps(runnerOf(failWith('timeout'))), {
      pdfSha256: TINY_SHA,
    });
    expect(timeout).toMatchObject({ ok: false, llmKind: 'timeout', state: 'context_pending' });
    const manifest = await store.readManifest(TINY_SHA);
    expect(manifest.errors.map((e) => e.code)).toEqual([
      'llm_needs_login',
      'llm_quota',
      'llm_timeout',
    ]);
    expect(new Set(manifest.errors.map((e) => e.id)).size).toBe(3);

    const again = await runContextPass(deps(runnerOf(okWith(goodOutput))), {
      pdfSha256: TINY_SHA,
    });
    expect(again).toMatchObject({ ok: true, state: 'context_pending' });
  });

  it('시작할 수 없는 상태, 너무 긴 본문은 모델을 부르지 않는다', async () => {
    const runner = runnerOf(okWith(goodOutput));
    const long = await runContextPass(deps(runner), { pdfSha256: TINY_SHA, maxInputTokens: 1 });
    expect(long).toMatchObject({ ok: false, code: 'body_too_long', state: 'mapping' });
    await store.updateManifest(TINY_SHA, (m) => {
      m.state = 'translating';
    });
    const wrong = await runContextPass(deps(runner), { pdfSha256: TINY_SHA });
    expect(wrong).toMatchObject({ ok: false, code: 'invalid_state', state: 'translating' });
    expect(runner.requests).toEqual([]);
  });

  it('스키마와 다른 값을 받으면 output_shape', async () => {
    const runner = runnerOf(okWith(() => ({ summary: '요약만' })));
    const result = await runContextPass(deps(runner), { pdfSha256: TINY_SHA });
    expect(result).toMatchObject({ ok: false, code: 'output_shape' });
  });

  it('같은 시각에 두 번 성공하면 세대 ID가 겹치지 않는다', async () => {
    const a = await runContextPass(deps(runnerOf(okWith(goodOutput))), { pdfSha256: TINY_SHA });
    const b = await runContextPass(deps(runnerOf(okWith(goodOutput))), { pdfSha256: TINY_SHA });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.generationId).toBe(`${a.generationId}_2`);
      expect((await store.readManifest(TINY_SHA)).currentGenerationId).toBe(b.generationId);
    }
  });
});

describe('validateContextOutput', () => {
  const load = async (): Promise<ReturnType<typeof buildContextInput>> => {
    const manifest = await store.readManifest(TINY_SHA);
    const document = await store.readJson(
      'extractionDocument',
      store.extractionPath(TINY_SHA, manifest.currentExtractionRevision ?? '', 'document.json'),
    );
    return buildContextInput(document);
  };
  const bodyFrom = (input: ReturnType<typeof buildContextInput>): ContextBodySection[] =>
    input.body;

  it('정상 출력은 문제가 없다', async () => {
    const input = await load();
    expect(validateContextOutput(goodOutput(bodyFrom(input)), input).problems).toEqual([]);
  });

  it('범위를 나눠 적어도 합쳐서 모두 덮으면 통과한다', async () => {
    const input = await load();
    const good = goodOutput(bodyFrom(input));
    const split = input.body.flatMap((s) =>
      s.sentences.map((x) => ({
        sectionId: s.id,
        startSentenceId: x.id,
        endSentenceId: x.id,
        status: 'covered' as const,
      })),
    );
    expect(validateContextOutput({ ...good, coverage: split }, input).problems).toEqual([]);
  });

  it('모르는 ID, 다른 섹션의 문장, partial 표시를 잡는다', async () => {
    const input = await load();
    const good = goodOutput(bodyFrom(input));
    const first = good.coverage[0];
    if (!first) throw new Error('coverage가 비었습니다');
    const codes = (coverage: ContextModelOutput['coverage']): string[] =>
      validateContextOutput({ ...good, coverage }, input).problems.map((p) => p.code);

    expect(codes([...good.coverage, { ...first, sectionId: 'sec999' }])).toEqual([
      'unknown_section',
    ]);
    expect(codes([{ ...first, endSentenceId: 's999' }, ...good.coverage.slice(1)])).toEqual([
      'unknown_sentence',
      'section_not_covered',
    ]);
    expect(codes([{ ...first, status: 'partial' }, ...good.coverage.slice(1)])).toEqual([
      'section_not_covered',
    ]);
    // 원래 ID를 그대로 돌려줘도 받지 않는다. 모델에 보낸 것은 별칭뿐이다.
    const realId = input.sections[0]?.sectionId ?? '';
    expect(codes([{ ...first, sectionId: realId }, ...good.coverage.slice(1)])).toContain(
      'unknown_section',
    );
  });

  it('빈 요약과 빈 용어집은 실패, 없는 근거 id와 중복 용어는 버리고 기록한다', async () => {
    const input = await load();
    const good = goodOutput(bodyFrom(input));
    const entry = good.glossary[0];
    if (!entry) throw new Error('용어집이 비었습니다');
    expect(
      validateContextOutput({ ...good, summary: ' ', glossary: [] }, input).problems.map(
        (p) => p.code,
      ),
    ).toEqual(['empty_summary', 'empty_glossary']);

    const checked = validateContextOutput(
      {
        ...good,
        glossary: [
          { ...entry, evidenceSentenceIds: [...entry.evidenceSentenceIds, 's999'] },
          { ...entry, term: 'Retrieval' },
          { ...entry, term: 'generator', preferredKo: '생성기' },
        ],
      },
      input,
    );
    expect(checked.problems).toEqual([]);
    expect(checked.glossary.map((g) => [g.id, g.term])).toEqual([
      ['g_1', 'retrieval'],
      ['g_2', 'generator'],
    ]);
    expect(checked.glossary[0]?.evidenceSentenceIds).toHaveLength(1);
    expect(checked.notes).toHaveLength(2);
  });

  it('서술 글에 남은 프롬프트용 id는 개수를 기록한다', async () => {
    const input = await load();
    const good = goodOutput(bodyFrom(input));
    const first = input.body[0]?.sentences[0]?.id ?? 's1';
    const checked = validateContextOutput(
      { ...good, mainResults: [`결과가 좋다(${first}, ${input.body[0]?.id ?? 'sec1'}, s99999).`] },
      input,
    );
    expect(checked.problems).toEqual([]);
    expect(checked.notes).toEqual(['서술 글에 프롬프트용 id가 2개 남아 있습니다']);
  });
});
