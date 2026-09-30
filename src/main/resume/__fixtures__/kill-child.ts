import { PaperCacheStore } from '../../cache/paper-cache-store';
import type { LlmJobRequest, LlmJobResult, LlmJobRunner } from '../../llm/job';
import { INPUT_PREAMBLE } from '../../prompt/template';
import { PaperScheduler } from '../../scheduler/paper-scheduler';
import type { ChunkPromptInputs } from '../../translate/chunk-input';

/**
 * 재시작 복구 테스트(COMMIT_PLAN C3.3)가 자식 프로세스로 띄우는 스크립트. recover.test.ts가 esbuild로 묶어 실행한다.
 * 인자: <캐시 root> <sha256>. 논문의 document.json은 부모가 미리 써 둔다.
 * 가짜 실행기로 컨텍스트와 첫 청크를 끝내고, 둘째 청크는 문장 하나의 출력만 조각으로 보낸 뒤
 * 끝나지 않는다. 조각이 파일에 넘어간 뒤 stdout에 READY를 쓴다. 부모가 그때 SIGKILL로 죽인다.
 */
const [root, sha] = process.argv.slice(2);
if (!root || !sha) throw new Error('인자: <root> <sha256>');

const dataOf = (request: LlmJobRequest): Record<string, unknown> =>
  JSON.parse(request.prompt.slice(INPUT_PREAMBLE.length + 1)) as Record<string, unknown>;

const contextValue = (request: LlmJobRequest): unknown => {
  const body = dataOf(request)['PAPER_BODY'] as { id: string; sentences: { id: string }[] }[];
  return {
    summary: '요약',
    researchQuestion: '문제',
    contributions: [],
    methodOverview: '방법',
    mainResults: [],
    limitations: [],
    glossary: [
      {
        term: 'sentence',
        aliases: [],
        preferredKo: '문장',
        acceptedKo: [],
        displayRule: '',
        meaningInPaper: '',
        evidenceSentenceIds: [],
      },
    ],
    concepts: [],
    unresolved: [],
    coverage: body.map((s) => ({
      sectionId: s.id,
      startSentenceId: s.sentences[0]?.id ?? '',
      endSentenceId: s.sentences.at(-1)?.id ?? '',
      status: 'covered',
    })),
  };
};
const sentence = (id: string, ko: string): Record<string, unknown> => ({
  id,
  ko,
  explain: '',
  example: '',
  caution: '',
  conceptIds: [],
  warnings: [],
});

const runner: LlmJobRunner = {
  run: (request, onEvent) => {
    const ok = (value: unknown): LlmJobResult => ({
      ok: true,
      jobId: request.jobId,
      value,
      rawText: JSON.stringify(value),
      model: 'fake-model',
      usage: { logicalJobs: 1, turnCount: 1, elapsedMs: 1 },
    });
    if (request.jobId.startsWith('ctx_')) return Promise.resolve(ok(contextValue(request)));
    const inputs = dataOf(request) as unknown as ChunkPromptInputs;
    if (request.jobId.includes('chunk_0001')) {
      return Promise.resolve(
        ok({
          kind: 'results',
          results: inputs.TARGET_SENTENCES.map((s) => sentence(s.id, `자식 번역 ${s.id}`)),
        }),
      );
    }
    // 둘째 청크: 첫 문장은 끝까지, 둘째 문장은 쓰다가 멈춘다. 그 뒤로 끝나지 않는다.
    const first = inputs.TARGET_SENTENCES[0]?.id ?? '';
    const second = inputs.TARGET_SENTENCES[1]?.id ?? '';
    const partial = `{"kind":"results","results":[${JSON.stringify(sentence(first, `자식 번역 ${first}`))},{"id":"${second}","ko":"쓰다가`;
    onEvent?.({
      type: 'output',
      jobId: request.jobId,
      chars: partial.length,
      item: 1,
      delta: partial,
    });
    setTimeout(() => process.stdout.write('READY\n'), 1_500);
    return new Promise(() => undefined);
  },
  cancel: (jobId) => Promise.resolve({ jobId, status: 'not_found' }),
  activeJobIds: () => [],
};

const store = new PaperCacheStore(root);
const scheduler = new PaperScheduler({
  store,
  runner,
  provider: 'codex',
  runtimeVersion: () => 'child',
  chunker: { minTokens: 150, maxTokens: 250, neighborSentences: 1 },
  concurrency: 1,
  log: (line) => process.stdout.write(`${line}\n`),
});
void scheduler.run(sha);
setInterval(() => undefined, 1_000);
