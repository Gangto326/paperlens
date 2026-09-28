import { describe, expect, it } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  CodexRuntime,
  type CodexRuntimeError,
  buildChildEnv,
  builtinToolsOf,
  formatToolInventory,
  verifyEffectiveConfig,
} from './codex-runtime';
import { resolveCodexBinary, type CodexBinary } from './codex-binary';
import { appServerArgs, DISABLED_FEATURES, renderConfigToml, type CodexHome } from './codex-home';
import type { Config } from './protocol/v2/Config';

const goodConfig = (): Config =>
  ({
    approval_policy: 'never',
    sandbox_mode: 'read-only',
    web_search: 'disabled',
    features: Object.fromEntries(DISABLED_FEATURES.map((n) => [n, false])),
    mcp_servers: {},
  }) as unknown as Config;

const HOME: CodexHome = {
  root: '/tmp/x/codex-home',
  configPath: '/tmp/x/codex-home/config.toml',
  homeDir: '/tmp/x/codex-home/home',
  workspaceDir: '/tmp/x/codex-home/workspace',
};

describe('CodexRuntime 순수 부분', () => {
  it('verifyEffectiveConfig: 규칙대로면 비어 있고, 어긋난 항목을 이름으로 든다', () => {
    expect(verifyEffectiveConfig(goodConfig())).toEqual([]);
    const bad = goodConfig();
    bad.approval_policy = 'on-request';
    bad.web_search = 'live';
    (bad as Record<string, unknown>)['features'] = {
      ...(bad['features'] as object),
      shell_tool: true,
    };
    (bad as Record<string, unknown>)['mcp_servers'] = { rogue: { command: 'x' } };
    const m = verifyEffectiveConfig(bad);
    expect(m).toContain('approval_policy="on-request"');
    expect(m).toContain('web_search="live"');
    expect(m).toContain('features.shell_tool=true');
    expect(m.some((x) => x.startsWith('mcp_servers=rogue'))).toBe(true);
    // features가 아예 없으면 전부 불일치
    const none = goodConfig();
    delete (none as Record<string, unknown>)['features'];
    expect(verifyEffectiveConfig(none).length).toBe(DISABLED_FEATURES.length);
  });

  it('조사용 방식은 내장 검색과 code_mode_host만 켜고 나머지는 번역용과 같다', () => {
    expect(appServerArgs('plain')).toEqual([
      'app-server',
      '--strict-config',
      '--listen',
      'stdio://',
    ]);
    expect(appServerArgs('research')).toEqual([
      'app-server',
      '-c',
      'features.code_mode_host=true',
      '-c',
      'web_search="live"',
      '--strict-config',
      '--listen',
      'stdio://',
    ]);
    const research = goodConfig();
    research.web_search = 'live';
    (research as Record<string, unknown>)['features'] = {
      ...(research['features'] as object),
      code_mode_host: true,
    };
    expect(verifyEffectiveConfig(research, 'research')).toEqual([]);
    // 같은 설정이 번역용으로는 통과하지 못한다. 반대도 같다.
    expect(verifyEffectiveConfig(research, 'plain')).toEqual([
      'web_search="live"',
      'features.code_mode_host=true',
    ]);
    expect(verifyEffectiveConfig(goodConfig(), 'research')).toEqual([
      'web_search="disabled"',
      'features.code_mode_host=false',
    ]);
    // 조사용이라도 다른 기능이 켜져 있으면 시작하지 않는다.
    (research as Record<string, unknown>)['features'] = {
      ...(research['features'] as object),
      shell_tool: true,
    };
    expect(verifyEffectiveConfig(research, 'research')).toEqual(['features.shell_tool=true']);
  });

  it('buildChildEnv: OPENAI_*·CODEX_*를 넘기지 않고 HOME·CODEX_HOME을 앱 디렉터리로 둔다', () => {
    const env = buildChildEnv(
      {
        PATH: '/usr/bin',
        HOME: '/Users/someone',
        OPENAI_API_KEY: 'sk-secret',
        CODEX_HOME: '/Users/someone/.codex',
        LANG: 'ko_KR.UTF-8',
        SHELL: '/bin/zsh',
      },
      HOME,
    );
    expect(env).toEqual({
      PATH: '/usr/bin',
      LANG: 'ko_KR.UTF-8',
      HOME: HOME.homeDir,
      CODEX_HOME: HOME.root,
    });
  });

  it('builtinToolsOf·formatToolInventory: 규칙 설정이면 전부 off', () => {
    const builtin = builtinToolsOf(goodConfig());
    expect(builtin.every((b) => !b.enabled)).toBe(true);
    const on = goodConfig();
    (on as Record<string, unknown>)['features'] = {
      ...(on['features'] as object),
      unified_exec: true,
    };
    expect(builtinToolsOf(on).find((b) => b.name === 'shell')?.enabled).toBe(true);
    const line = formatToolInventory({
      threadId: 't1',
      builtin,
      mcp: [{ server: 'r', status: 'connected', tools: ['search', 'fetch'], error: null }],
    });
    expect(line).toContain('thread=t1');
    expect(line).toContain('shell=off');
    expect(line).toContain('r[connected]{search,fetch}');
  });
});

const binary: CodexBinary | null = (() => {
  try {
    return resolveCodexBinary();
  } catch {
    return null;
  }
})();

const FAKE_MCP = join(__dirname, '__fixtures__', 'fake-mcp-server.mjs');

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms: number): Promise<T> {
  const end = Date.now() + ms;
  let last = await fn();
  while (!ok(last) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 200));
    last = await fn();
  }
  return last;
}

/** 실제 @openai/codex 바이너리(없으면 skip)로 C1.18 확인 항목을 돌린다. 네트워크 없이도 통과한다(로그인 불필요). */
describe.skipIf(!binary)('CodexRuntime (실제 app-server)', () => {
  it('시작 → 유효 설정 검증 → 스레드별 MCP 노출 범위 → 정상 종료', async () => {
    const userData = await fs.mkdtemp(join(tmpdir(), 'paperlens-userdata-'));
    const logs: string[] = [];
    const rt = new CodexRuntime({
      userDataPath: userData,
      appVersion: '0.0.0-test',
      log: (l) => logs.push(l),
    });
    const info = await rt.start();
    try {
      expect(rt.status).toBe('running');
      expect(info.home.root).toBe(join(userData, 'codex-home'));
      expect(await fs.realpath(info.serverCodexHome)).toBe(await fs.realpath(info.home.root));
      expect(info.userAgent).toContain('paperlens/');
      expect(await fs.readFile(info.home.configPath, 'utf8')).toBe(renderConfigToml());
      expect(verifyEffectiveConfig(rt.effectiveConfig as Config)).toEqual([]);

      const plain = await rt.startThread();
      expect(plain.sandbox).toEqual({ type: 'readOnly', networkAccess: false });
      expect(plain.approvalPolicy).toBe('never');
      expect(plain.threadId).toMatch(/^[0-9a-f-]{36}$/);

      const research = await rt.startThread({
        mcpServers: { paperlens_research: { command: process.execPath, args: [FAKE_MCP] } },
      });
      const researchMcp = await waitFor(
        () => rt.listMcpServers(research.threadId),
        (v) => v.some((s) => s.status === 'connected'),
        10_000,
      );
      expect(researchMcp).toEqual([
        {
          server: 'paperlens_research',
          status: 'connected',
          tools: ['fetch', 'search'],
          error: null,
        },
      ]);
      // 덮어쓰지 않은 스레드와 전역에는 MCP 서버가 없다 (0.4-B 1순위 성립).
      expect(await rt.listMcpServers(plain.threadId)).toEqual([]);
      expect(await rt.listMcpServers()).toEqual([]);

      const inv = await rt.toolInventory(plain.threadId);
      expect(inv.builtin.every((b) => !b.enabled)).toBe(true);
      expect(inv.mcp).toEqual([]);
      expect(formatToolInventory(inv)).toContain('shell=off');

      // 플러그인이 꺼져 있어 시작 시 마켓플레이스 clone(.tmp/plugins-clone-*)이 없다.
      expect(existsSync(join(info.home.root, '.tmp'))).toBe(false);
    } finally {
      const exit = await rt.stop();
      expect(exit).toMatchObject({ code: 0, expected: true });
      expect(rt.status).toBe('stopped');
    }
  }, 40_000);

  it('조사용 방식으로 시작하면 유효 설정에 내장 검색이 켜져 있고 config.toml은 그대로다', async () => {
    const userData = await fs.mkdtemp(join(tmpdir(), 'paperlens-userdata-'));
    const rt = new CodexRuntime({
      userDataPath: userData,
      appVersion: '0.0.0-test',
      profile: 'research',
    });
    const info = await rt.start();
    try {
      expect(rt.status).toBe('running');
      expect(await fs.readFile(info.home.configPath, 'utf8')).toBe(renderConfigToml());
      const config = rt.effectiveConfig as Config;
      expect(config.web_search).toBe('live');
      expect((config['features'] as Record<string, unknown>)['code_mode_host']).toBe(true);
      expect(verifyEffectiveConfig(config, 'research')).toEqual([]);
      const inv = await rt.toolInventory((await rt.startThread()).threadId);
      expect(inv.builtin.filter((b) => b.enabled).map((b) => b.name)).toEqual(['web_search']);
      expect(inv.mcp).toEqual([]);
    } finally {
      const exit = await rt.stop();
      expect(exit).toMatchObject({ code: 0, expected: true });
    }
  }, 40_000);

  it('유효 설정이 규칙과 다르면 시작 실패로 취급하고 프로세스를 내린다', async () => {
    const userData = await fs.mkdtemp(join(tmpdir(), 'paperlens-userdata-'));
    const rt = new CodexRuntime({
      userDataPath: userData,
      appVersion: '0.0.0-test',
      // -c 로 approval_policy를 덮어써 config/read가 규칙과 다르게 나오게 한다.
      spawn: (cmd, args, opts) =>
        spawn(cmd, [...args, '-c', 'approval_policy="on-request"'], {
          ...opts,
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
    });
    await expect(rt.start()).rejects.toMatchObject({
      name: 'CodexRuntimeError',
      kind: 'config_mismatch',
    } satisfies Partial<CodexRuntimeError>);
    expect(rt.status).toBe('failed');
    expect(rt.client?.state).toBe('exited');
  }, 20_000);
});
