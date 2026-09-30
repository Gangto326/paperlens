import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExtractionDocument, Section, Sentence } from '@shared/schema';
import { sampleChunk, sampleExtraction } from '@shared/schema/fixtures';
import { sha256Hex, stableStringify } from '../cache/hash';
import { PaperCacheStore } from '../cache/paper-cache-store';
import type { LlmJobRequest, LlmJobResult, LlmJobRunner } from '../llm/job';
import { INPUT_PREAMBLE } from '../prompt/template';
import { PaperScheduler } from '../scheduler/paper-scheduler';
import type { ChunkPromptInputs } from '../translate/chunk-input';
import { acquireJobLock, lockPath } from './job-lock';
import { recoverPaper } from './recover';

/** 재시작 복구와 작업 락(COMMIT_PLAN C3.3). */
const SHA = '9'.repeat(64);
const REV = 'rtest';
const NOW = new Date('2026-09-30T03:00:00.000Z');

/** 섹션 3개, 섹션마다 문장 2개. kill-child.ts와 청크 나누기가 같다(청크 하나에 문장 2개). */
const makeDocument = (): ExtractionDocument => {
  const sections: Section[] = [];
  const sentences: Sentence[] = [];
  for (let i = 0; i < 3; i += 1) {
    const ids: string[] = [];
    for (let k = 0; k < 2; k += 1) {
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
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'paperlens-recover-'));
  store = new PaperCacheStore(root);
  await store.initPaper(SHA, NOW);
  const path = store.extractionPath(SHA, REV, 'document.json');
  const sha = await store.writeJson('extractionDocument', path, makeDocument());
  await store.updateManifest(SHA, (m) => {
    store.recordFile(m, SHA, path, sha);
    m.currentExtractionRevision = REV;
    m.state = 'mapping';
  });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const GEN = 'gen_x';
const chunkPath = (id: string): string => store.generationPath(SHA, GEN, `chunks/${id}.json`);
const files = async (): Promise<string[]> =>
  (await store.readManifest(SHA)).files.map((f) => f.path).sort();

describe('recoverPaper', () => {
  it('해시가 다른 세대 파일은 기록에서 빼고 지운다. 추출 파일은 건드리지 않는다', async () => {
    const good = await store.writeJson('chunkDocument', chunkPath('chunk_0001'), sampleChunk);
    const bad = await store.writeJson('chunkDocument', chunkPath('chunk_0002'), {
      ...sampleChunk,
      id: 'chunk_0002',
    });
    const contextPath = store.generationPath(SHA, GEN, 'context.json');
    await store.updateManifest(SHA, (m) => {
      store.recordFile(m, SHA, chunkPath('chunk_0001'), good);
      store.recordFile(m, SHA, chunkPath('chunk_0002'), bad);
      store.recordFile(m, SHA, contextPath, 'a'.repeat(64));
      m.state = 'translating';
    });
    await fs.writeFile(chunkPath('chunk_0002'), '{"broken":');
    await fs.writeFile(join(store.paperDir(SHA), 'generations', GEN, '.x.json.1.ab.tmp'), '');

    const report = await recoverPaper(store, SHA, { now: () => NOW });
    expect(report).toMatchObject({
      removedTemp: [join('generations', GEN, '.x.json.1.ab.tmp')],
      dropped: [
        { path: join('generations', GEN, 'chunks', 'chunk_0002.json'), problem: 'hash_mismatch' },
        { path: join('generations', GEN, 'context.json'), problem: 'missing' },
      ],
      adopted: [],
      discarded: [],
      stateBefore: 'translating',
      stateAfter: 'translating',
    });
    expect(await files()).toEqual([
      join('extraction', REV, 'document.json'),
      join('generations', GEN, 'chunks', 'chunk_0001.json'),
    ]);
    expect(await store.exists(chunkPath('chunk_0002'))).toBe(false);
    const manifest = await store.readManifest(SHA);
    expect(manifest.errors.map((e) => [e.stage, e.code])).toEqual([
      ['recovery', 'file_hash_mismatch'],
      ['recovery', 'file_missing'],
    ]);
    expect(await store.verifyFiles(SHA)).toEqual([]);
  });

  it('기록에 없는 청크 파일은 온전한 완료 결과면 적고, 아니면 지운다', async () => {
    const complete = {
      ...sampleChunk,
      status: 'complete' as const,
      resultHash: sha256Hex(stableStringify(sampleChunk.results)),
      targetSentenceIds: sampleChunk.results.map((r) => r.id),
    };
    await store.writeJson('chunkDocument', chunkPath('chunk_0001'), complete);
    await store.writeJson('chunkDocument', chunkPath('chunk_0002'), {
      ...complete,
      id: 'chunk_0002',
      resultHash: 'b'.repeat(64),
    });
    await store.writeJson('chunkDocument', chunkPath('chunk_0003'), {
      ...sampleChunk,
      id: 'chunk_0003',
      status: 'pending',
    });
    await fs.writeFile(chunkPath('chunk_0004'), 'not json');

    const report = await recoverPaper(store, SHA);
    expect(report.adopted).toEqual([join('generations', GEN, 'chunks', 'chunk_0001.json')]);
    expect(report.discarded.sort()).toEqual(
      ['chunk_0002', 'chunk_0003', 'chunk_0004'].map((id) =>
        join('generations', GEN, 'chunks', `${id}.json`),
      ),
    );
    expect(await files()).toContain(join('generations', GEN, 'chunks', 'chunk_0001.json'));
    expect(await store.verifyFiles(SHA)).toEqual([]);
    expect(await store.exists(chunkPath('chunk_0002'))).toBe(false);
  });

  it('조사 도중에 죽었으면 다시 시작할 수 있는 상태로 돌린다. 고칠 것이 없으면 manifest를 쓰지 않는다', async () => {
    await store.updateManifest(SHA, (m) => {
      m.state = 'researching';
    });
    const before = (await store.readManifest(SHA)).updatedAt;
    expect(await recoverPaper(store, SHA, { now: () => NOW })).toMatchObject({
      stateBefore: 'researching',
      stateAfter: 'context_pending',
    });
    expect((await store.readManifest(SHA)).state).toBe('context_pending');
    const again = await recoverPaper(store, SHA, { now: () => new Date('2030-01-01') });
    expect(again.stateBefore).toBe('context_pending');
    expect((await store.readManifest(SHA)).updatedAt).not.toBe(before);
    expect((await store.readManifest(SHA)).updatedAt).toBe(NOW.toISOString());
  });
});

describe('acquireJobLock', () => {
  it('잡은 락은 다른 pid가 살아 있으면 잡지 못하고, 죽은 pid의 락은 치우고 잡는다', async () => {
    const mine = await acquireJobLock(store, SHA, { now: () => NOW });
    expect(mine).toMatchObject({ ok: true, tookOver: null });
    // 살아 있는 다른 프로세스(부모)가 잡은 것처럼 본다.
    await fs.writeFile(lockPath(store, SHA), JSON.stringify({ pid: process.ppid, startedAt: 'x' }));
    expect(await acquireJobLock(store, SHA, { pid: 424242 })).toMatchObject({
      ok: false,
      holder: { pid: process.ppid },
    });
    // 없는 pid의 락
    await fs.writeFile(
      lockPath(store, SHA),
      JSON.stringify({ pid: 2_147_483_000, startedAt: 'y' }),
    );
    const taken = await acquireJobLock(store, SHA);
    expect(taken).toMatchObject({ ok: true, tookOver: { pid: 2_147_483_000 } });
    if (taken.ok) await taken.release();
    expect(await store.exists(lockPath(store, SHA))).toBe(false);
    // 읽을 수 없는 락도 치운다. 풀 때는 자기 락만 지운다.
    await fs.writeFile(lockPath(store, SHA), 'garbage');
    const again = await acquireJobLock(store, SHA);
    expect(again.ok).toBe(true);
    await fs.writeFile(lockPath(store, SHA), JSON.stringify({ pid: 1, startedAt: 'z' }));
    if (again.ok) await again.release();
    expect(await store.exists(lockPath(store, SHA))).toBe(true);
  });
});

const dataOf = (request: LlmJobRequest): Record<string, unknown> =>
  JSON.parse(request.prompt.slice(INPUT_PREAMBLE.length + 1)) as Record<string, unknown>;

describe('kill -9 뒤 재시작', () => {
  let child: ChildProcess | null = null;
  afterEach(() => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
  });

  it('완료 결과는 남고, 완료 청크와 컨텍스트를 다시 요청하지 않으며, 끊긴 청크는 이어서 한다', async () => {
    const out = join(root, 'kill-child.mjs');
    await build({
      entryPoints: [resolve(__dirname, '__fixtures__', 'kill-child.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: out,
      alias: { '@shared': resolve(__dirname, '..', '..', 'shared') },
      logLevel: 'silent',
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
    });
    child = spawn(process.execPath, [out, root, SHA], { stdio: ['ignore', 'pipe', 'inherit'] });
    const lines: string[] = [];
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`자식이 준비되지 않음:\n${lines.join('\n')}`)),
        15_000,
      );
      child?.stdout?.on('data', (buf: Buffer) => {
        for (const line of buf.toString('utf8').split('\n')) {
          if (line === '') continue;
          lines.push(line);
          if (line === 'READY') {
            clearTimeout(timer);
            resolveReady();
          }
        }
      });
      child?.on('exit', (code) => reject(new Error(`자식이 먼저 끝남 code=${String(code)}`)));
    });
    child.removeAllListeners('exit');
    child.kill('SIGKILL');
    await new Promise<void>((r) => child?.on('exit', () => r()));

    // 죽은 뒤의 캐시: 락이 남아 있고, 첫 청크만 완료, 둘째 청크의 조각은 inflight에 있다.
    const before = await store.readManifest(SHA);
    expect(before.state).toBe('translating');
    const gen = before.currentGenerationId ?? '';
    expect(await store.exists(lockPath(store, SHA))).toBe(true);
    expect(before.files.filter((f) => f.path.includes('chunks/'))).toHaveLength(1);
    const inflightDir = store.inflightDir(SHA, gen);
    const partial = await fs.readFile(join(inflightDir, `tr_${gen}_chunk_0002_1.txt`), 'utf8');
    expect(partial).toContain('자식 번역 s3');

    const requests: LlmJobRequest[] = [];
    const runner: LlmJobRunner = {
      run: (request) => {
        requests.push(request);
        const inputs = dataOf(request) as unknown as ChunkPromptInputs;
        const value = {
          kind: 'results',
          results: inputs.TARGET_SENTENCES.map((s) => ({
            id: s.id,
            ko: `부모 번역 ${s.id}`,
            explain: '',
            example: '',
            caution: '',
            conceptIds: [],
            warnings: [],
          })),
        };
        const result: LlmJobResult = {
          ok: true,
          jobId: request.jobId,
          value,
          rawText: JSON.stringify(value),
          model: null,
          usage: { logicalJobs: 1, turnCount: 1, elapsedMs: 1 },
        };
        return Promise.resolve(result);
      },
      cancel: (jobId) => Promise.resolve({ jobId, status: 'not_found' }),
      activeJobIds: () => [],
    };
    const scheduler = new PaperScheduler({
      store,
      runner,
      provider: 'codex',
      runtimeVersion: () => 'parent',
      chunker: { minTokens: 150, maxTokens: 250, neighborSentences: 1 },
      concurrency: 1,
      now: () => NOW,
    });
    const outcome = await scheduler.run(SHA);
    expect(outcome).toMatchObject({
      reason: 'complete',
      generationId: gen,
      completedChunks: 3,
      failedChunks: 0,
    });
    // 컨텍스트와 첫 청크는 다시 요청하지 않는다. 둘째 청크는 끊긴 문장부터, 셋째는 처음부터.
    expect(requests.map((r) => r.jobId.replace(/^.*_(chunk_\d+_\d+)$/, '$1'))).toEqual([
      'chunk_0002_2',
      'chunk_0003_1',
    ]);
    expect(
      requests.map((r) =>
        (dataOf(r) as unknown as ChunkPromptInputs).TARGET_SENTENCES.map((s) => s.id),
      ),
    ).toEqual([['s4'], ['s5', 's6']]);
    expect(outcome.metrics.map((m) => [m.outcome, m.recovered])).toEqual([
      ['reused', 0],
      ['complete', 1],
      ['complete', 0],
    ]);
    const second = await store.readJson('chunkDocument', chunkPath('chunk_0002').replace(GEN, gen));
    expect(second.results.map((r) => r.ko)).toEqual(['자식 번역 s3', '부모 번역 s4']);
    expect(await store.verifyFiles(SHA)).toEqual([]);
    expect(await store.exists(lockPath(store, SHA))).toBe(false);
    expect(await fs.readdir(inflightDir)).toEqual([]);
  }, 60_000);
});
