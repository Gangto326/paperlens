import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AdditionalExplanation, AdditionalTarget } from '@shared/additional-explanation';
import { PaperCacheStore } from '../cache/paper-cache-store';
import { PaperDataDeletion } from '../cache/paper-data-deletion';
import type { LlmJobRunner, LlmJobResult } from '../llm/job';
import { AdditionalExplanations } from './additional-explanations';

const sha = 'a'.repeat(64);
const section: AdditionalTarget = { kind: 'section', sentenceId: 's1', section: 'main' };
const concept: AdditionalTarget = { kind: 'concept', conceptId: 'c1' };
const usage = { logicalJobs: 1, turnCount: 1, elapsedMs: 1 };
const success = (text = '쉬운 설명입니다.\n\n1. 먼저 관련 자료를 찾습니다.'): LlmJobResult => ({
  ok: true,
  jobId: 'test',
  value: { explanation: text },
  rawText: '{}',
  model: null,
  usage,
});
let root: string;
let store: PaperCacheStore;
let source: string;
let events: AdditionalExplanation[];
let service: AdditionalExplanations;
let run: ReturnType<typeof vi.fn<LlmJobRunner['run']>>;
const make = (): AdditionalExplanations =>
  new AdditionalExplanations(
    store,
    {
      run,
      cancel: (id) => Promise.resolve({ jobId: id, status: 'not_found' }),
      activeJobIds: () => [],
    },
    () => Promise.resolve({ source, context: { original: 'We study RAG.' } }),
    (state) => events.push(state),
  );
const settled = async (): Promise<void> => {
  await vi.waitFor(() => expect(service.isRunning(sha)).toBe(false));
};
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'paperlens-additional-'));
  store = new PaperCacheStore(root);
  source = '원래 해설';
  events = [];
  run = vi.fn(() => Promise.resolve(success()));
  service = make();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

it('생성 중 표시 후 저장하며 새 프로세스에서도 AI 재호출 없이 읽는다', async () => {
  expect((await service.request(sha, section)).status).toBe('running');
  await settled();
  expect(events[0]?.status).toBe('running');
  expect(events.at(-1)?.status).toBe('complete');
  expect(events.at(-1)?.text).toContain('쉬운 설명');
  const restarted = make();
  expect(await restarted.read(sha)).toMatchObject([{ target: section, status: 'complete' }]);
  await restarted.request(sha, section);
  await vi.waitFor(() => expect(restarted.isRunning(sha)).toBe(false));
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]?.[0].research).toEqual({ kind: 'none' });
});

it('같은 항목 동시 요청을 하나로 합치고 생성 중 삭제를 막는다', async () => {
  let finish!: (result: LlmJobResult) => void;
  run.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await Promise.all([service.request(sha, section), service.request(sha, section)]);
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  const deletion = new PaperDataDeletion(store, (id) => service.isRunning(id));
  await expect(deletion.remove(sha, () => Promise.resolve(true))).rejects.toThrow('진행 중');
  finish(success());
  await settled();
  await deletion.remove(sha, () => Promise.resolve(true));
  service.forget(sha);
  expect(await service.read(sha)).toEqual([]);
});

it('해설·개념·다른 논문을 분리하고 원 해설이 바뀌면 별도 응답을 보존한다', async () => {
  await service.request(sha, section);
  await settled();
  await service.request(sha, concept);
  await settled();
  source = '변경된 해설';
  await service.request(sha, section);
  await settled();
  expect(await service.read(sha)).toHaveLength(3);
  expect(await service.read('b'.repeat(64))).toEqual([]);
  expect(run).toHaveBeenCalledTimes(3);
});

it('한도 실패를 표시하고 명시적 재시도에서 다시 생성한다', async () => {
  run.mockResolvedValueOnce({
    ok: false,
    jobId: 'test',
    kind: 'quota',
    message: 'internal',
    errors: [],
    rawText: null,
    model: null,
    usage,
  });
  await service.request(sha, section);
  await settled();
  expect(events.at(-1)?.status).toBe('failed');
  expect(events.at(-1)?.message).toContain('한도');
  await service.request(sha, section);
  await settled();
  expect(events.at(-1)?.status).toBe('complete');
  expect(run).toHaveBeenCalledTimes(2);
});

it('저장 실패 시 응답을 화면에 유지하고 재생성 없이 다시 저장한다', async () => {
  vi.spyOn(store, 'writeText').mockRejectedValueOnce(new Error('disk full'));
  await service.request(sha, section);
  await settled();
  expect(events.at(-1)?.status).toBe('failed');
  expect(events.at(-1)?.text).toContain('쉬운 설명');
  expect(events.at(-1)?.message).toContain('저장하지 못');
  await service.request(sha, section);
  await settled();
  expect(events.at(-1)?.status).toBe('complete');
  expect(run).toHaveBeenCalledTimes(1);
  expect(await make().read(sha)).toHaveLength(1);
});

it('생성 이벤트에서 설명 본문이 아닌 메시지는 노출하지 않는다', async () => {
  run.mockImplementation((_request, event) => {
    event?.({ type: 'output', jobId: 'test', chars: 10, item: 1, delta: 'private raw reasoning' });
    event?.({ type: 'stage', jobId: 'test', stage: 'answer', state: 'started' });
    return Promise.resolve(success());
  });
  await service.request(sha, section);
  await settled();
  expect(events.some((e) => e.message.includes('작성'))).toBe(true);
  expect(JSON.stringify(events)).not.toContain('private raw');
});

it('완료 전 본문을 스트리밍하고 최종 검증된 응답만 저장한다', async () => {
  let emit!: NonNullable<Parameters<LlmJobRunner['run']>[1]>;
  let finish!: (result: LlmJobResult) => void;
  run.mockImplementation((_request, event) => {
    emit = event!;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  await service.request(sha, section);
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  emit({ type: 'output', jobId: 'test', chars: 30, item: 1, delta: '{"explanation":"먼저 자료를' });
  expect(events.at(-1)).toMatchObject({
    status: 'running',
    text: null,
    previewText: '먼저 자료를',
  });
  expect(await make().read(sha)).toEqual([]);
  emit({ type: 'output', jobId: 'test', chars: 40, item: 1, delta: ' 찾습니다.\\n다음 단계' });
  await vi.waitFor(() =>
    expect(events.at(-1)?.previewText).toBe('먼저 자료를 찾습니다.\n다음 단계'),
  );
  finish(success('완성된 설명입니다.'));
  await settled();
  expect(events.at(-1)).toMatchObject({ status: 'complete', text: '완성된 설명입니다.' });
  expect(events.at(-1)?.previewText).toBeUndefined();
  const directory = join(store.paperDir(sha), 'additional-explanations-v1');
  const [name] = await fs.readdir(directory);
  const saved = await fs.readFile(join(directory, name!), 'utf8');
  expect(saved).not.toContain('previewText');
  expect(saved).not.toContain('다음 단계');
});

it('메시지가 바뀌면 이전 미리보기를 붙이지 않고 새 본문만 표시한다', async () => {
  run.mockImplementation((_request, event) => {
    event?.({
      type: 'output',
      jobId: 'test',
      chars: 30,
      item: 1,
      delta: '{"explanation":"이전 답변',
    });
    event?.({
      type: 'output',
      jobId: 'test',
      chars: 60,
      item: 2,
      delta: '{"explanation":"새 답변',
    });
    return Promise.resolve(success('새 답변'));
  });
  await service.request(sha, section);
  await settled();
  expect(events.some((state) => state.previewText === '새 답변')).toBe(true);
  expect(events.some((state) => state.previewText?.includes('이전 답변새 답변'))).toBe(false);
});

it('부분 응답 실패는 미완성으로 남기며 재시도에서 반드시 다시 생성한다', async () => {
  run.mockImplementationOnce((_request, event) => {
    event?.({
      type: 'output',
      jobId: 'test',
      chars: 30,
      item: 1,
      delta: '{"explanation":"아직 미완성',
    });
    return Promise.resolve({
      ok: false,
      jobId: 'test',
      kind: 'timeout',
      message: 'timeout',
      errors: [],
      rawText: null,
      model: null,
      usage,
    });
  });
  await service.request(sha, section);
  await settled();
  expect(events.at(-1)).toMatchObject({ status: 'failed', text: null, previewText: '아직 미완성' });
  expect(events.at(-1)?.message).toContain('미완성');
  expect(await make().read(sha)).toEqual([]);
  await service.request(sha, section);
  await settled();
  expect(run).toHaveBeenCalledTimes(2);
  expect(events.at(-1)?.status).toBe('complete');
  expect(events.at(-1)?.previewText).toBeUndefined();
});

it('손상된 저장 응답과 잘못된 AI 출력은 완료로 표시하지 않는다', async () => {
  await service.request(sha, section);
  await settled();
  const dir = join(store.paperDir(sha), 'additional-explanations-v1');
  const [file] = await fs.readdir(dir);
  await fs.writeFile(join(dir, file!), '{bad json');
  service = make();
  expect(await service.read(sha)).toEqual([]);
  const bad = success();
  if (bad.ok) bad.value = { explanation: '' };
  run.mockResolvedValueOnce(bad);
  await service.request(sha, section);
  await settled();
  expect(events.at(-1)?.status).toBe('failed');
});
