import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv';
import type { LlmAccountStatus } from '@shared/ipc';
import { CACHE_SCHEMAS } from '@shared/schema';
import { AppServerClient } from './app-server-client';
import { CodexAccount } from './codex-account';
import {
  formatSmokeRecord,
  runStructuredSmoke,
  saveSmokeRecord,
  smokeRecordPath,
  type StructuredSmokeDeps,
  type StructuredSmokeRecord,
} from './codex-smoke';

const FIXTURE = join(__dirname, '__fixtures__', 'fake-app-server.mjs');
const NOW = new Date('2026-09-27T00:00:00Z');

describe('구조화 출력 스모크 (가짜 App Server)', () => {
  let client: AppServerClient | null = null;
  afterEach(async () => {
    await client?.close({ graceMs: 500, termMs: 500 });
    client = null;
  });

  const setup = (
    args: string[] = [],
  ): { c: AppServerClient; deps: StructuredSmokeDeps; threads: string[] } => {
    const child = spawn(process.execPath, [FIXTURE, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const c = new AppServerClient(child, { requestTimeoutMs: 5_000 });
    client = c;
    const account = new CodexAccount(() => c, { now: () => NOW });
    const threads: string[] = [];
    const deps: StructuredSmokeDeps = {
      transport: () => c,
      readAccount: () => account.read(),
      startThread: async () => {
        const res = await c.request<{ thread: { id: string }; model: string }>('thread/start', {});
        threads.push(res.thread.id);
        return { threadId: res.thread.id, model: res.model };
      },
      runtimeVersion: '0.0.0-fake',
      timeoutMs: 3_000,
      now: () => NOW,
    };
    return { c, deps, threads };
  };

  it('미로그인이면 스레드·턴을 만들지 않고 needs_login으로 끝난다', async () => {
    const { deps, threads } = setup();
    const record = await runStructuredSmoke(deps);
    expect(record).toMatchObject({
      ok: false,
      structuredOutput: 'unknown',
      failure: { kind: 'needs_login' },
      threadId: null,
      turnId: null,
      usage: { logicalJobs: 1, turnCount: 0, inputTokens: null },
    });
    expect(threads).toEqual([]);
    expect(formatSmokeRecord(record)).toContain('smoke failed structuredOutput=unknown');
  });

  it('로그인 상태면 1턴을 돌려 supported와 Usage를 기록하고 파일로 남긴다', async () => {
    const { c, deps } = setup();
    await c.request('test/completeLogin', { loginId: 'login-0', success: true });
    const record = await runStructuredSmoke(deps);
    expect(record).toMatchObject({
      schemaVersion: 1,
      checkedAt: NOW.toISOString(),
      runtimeVersion: '0.0.0-fake',
      model: 'fake-model',
      ok: true,
      structuredOutput: 'supported',
      echoMatched: true,
      failure: null,
      threadId: 'thread-1',
      turnId: 'turn-1',
      tokenUsageUpdates: 1,
      usage: {
        logicalJobs: 1,
        turnCount: 1,
        reportedModelCalls: null,
        inputTokens: 1200,
        cachedInputTokens: 200,
        outputTokens: 44,
        reasoningTokens: 10,
      },
    });
    // 저장하는 Usage는 manifest의 Usage 스키마와 같은 모양이어야 한다.
    const manifestSchema = CACHE_SCHEMAS.manifest as {
      properties: { usage: Record<string, unknown> };
    };
    const validateUsage = new Ajv({ strict: true, allowUnionTypes: true }).compile(
      manifestSchema.properties.usage,
    );
    expect(validateUsage(record.usage)).toBe(true);

    const userData = await fs.mkdtemp(join(tmpdir(), 'paperlens-smoke-'));
    const path = await saveSmokeRecord(userData, record);
    expect(path).toBe(smokeRecordPath(userData));
    const saved = JSON.parse(await fs.readFile(path, 'utf8')) as StructuredSmokeRecord;
    expect(saved).toEqual(record);
    expect(formatSmokeRecord(record)).toMatch(
      /^smoke ok structuredOutput=supported echo=true model=fake-model turns=1 in=1200 cached=200 out=44 reasoning=10 elapsed=\d+ms$/,
    );
  });

  it('응답이 스키마를 따르지 않으면 unsupported, 값만 다르면 supported·echo=false', async () => {
    const bad = setup(['--default-reply={"answer":"paperlens-ok","n":"three"}']);
    await bad.c.request('test/completeLogin', { loginId: 'login-0', success: true });
    const record = await runStructuredSmoke(bad.deps);
    expect(record).toMatchObject({
      ok: false,
      structuredOutput: 'unsupported',
      echoMatched: null,
      failure: { kind: 'schema_mismatch', errors: ['/n must be integer'] },
      turnId: 'turn-1',
      usage: { turnCount: 1, inputTokens: 1200 },
    });
    expect(formatSmokeRecord(record)).toContain(
      'smoke failed structuredOutput=unsupported kind=schema_mismatch',
    );
    await bad.c.close({ graceMs: 500, termMs: 500 });

    const other = setup(['--default-reply={"answer":"something else","n":4}']);
    await other.c.request('test/completeLogin', { loginId: 'login-0', success: true });
    expect(await runStructuredSmoke(other.deps)).toMatchObject({
      ok: true,
      structuredOutput: 'supported',
      echoMatched: false,
    });
  });

  it('로그인 확인 뒤에 인증이 사라졌으면 턴의 401을 needs_login으로 남긴다', async () => {
    const { deps } = setup();
    const authenticated: LlmAccountStatus = {
      state: 'authenticated',
      method: 'chatgpt',
      email: null,
      plan: null,
    };
    expect(
      await runStructuredSmoke({ ...deps, readAccount: () => Promise.resolve(authenticated) }),
    ).toMatchObject({
      ok: false,
      structuredOutput: 'unknown',
      failure: { kind: 'needs_login' },
      turnId: 'turn-1',
    });
  });

  it('런타임이 없으면 unavailable', async () => {
    const account = new CodexAccount(() => null);
    const record = await runStructuredSmoke({
      transport: () => null,
      readAccount: () => account.read(),
      startThread: () => Promise.reject(new Error('호출되면 안 된다')),
      runtimeVersion: null,
    });
    expect(record).toMatchObject({ ok: false, failure: { kind: 'unavailable' }, model: null });
  });
});
