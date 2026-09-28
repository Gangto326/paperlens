import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { AppServerClient, AppServerError, type ExitInfo } from './app-server-client';
import { resolveCodexBinary, type CodexBinary } from './codex-binary';
import {
  appServerArgs,
  CODEX_TOP_LEVEL_CONFIG,
  DISABLED_FEATURES,
  ensureCodexHome,
  expectedConfigOf,
  type CodexHome,
  type CodexProfile,
} from './codex-home';
import type { InitializeParams } from './protocol/InitializeParams';
import type { InitializeResponse } from './protocol/InitializeResponse';
import type { Config } from './protocol/v2/Config';
import type { ConfigReadParams } from './protocol/v2/ConfigReadParams';
import type { ConfigReadResponse } from './protocol/v2/ConfigReadResponse';
import type { ThreadStartParams } from './protocol/v2/ThreadStartParams';
import type { ThreadStartResponse } from './protocol/v2/ThreadStartResponse';
import type { ListMcpServerStatusParams } from './protocol/v2/ListMcpServerStatusParams';
import type { ListMcpServerStatusResponse } from './protocol/v2/ListMcpServerStatusResponse';
import type { McpServerConnectionStatus } from './protocol/v2/McpServerConnectionStatus';
import type { SandboxPolicy } from './protocol/v2/SandboxPolicy';
import type { AskForApproval } from './protocol/v2/AskForApproval';

/**
 * 앱이 소유하는 Codex App Server 자식 프로세스 (COMMIT_PLAN C1.18, PLAN 4.2).
 * 시작 순서: 바이너리 확인 → CODEX_HOME 준비 → spawn(`app-server --strict-config`) → initialize/initialized →
 * config/read로 유효 설정 검증(불일치면 시작 실패로 취급하고 프로세스를 내린다) → running.
 * 스레드는 항상 ephemeral·read-only·approval never로 시작하며, 조사용 스레드만 `config.mcp_servers`를 덮어쓴다(0.4-B 1순위, 실측 적용됨).
 */
export type McpServerConfig = { command: string; args?: string[]; env?: Record<string, string> };

export type SpawnFn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string },
) => ChildProcess;

export interface CodexRuntimeOptions {
  userDataPath: string;
  appVersion: string;
  /** 기본은 검색 없는 `plain`. 조사 전용 프로세스는 `research`. */
  profile?: CodexProfile;
  log?: (line: string) => void;
  /** 테스트 주입용 */
  spawn?: SpawnFn;
  parentEnv?: NodeJS.ProcessEnv;
  binary?: CodexBinary;
  requestTimeoutMs?: number;
}

export type CodexRuntimeStatus = 'stopped' | 'starting' | 'running' | 'crashed' | 'failed';

export interface CodexStartInfo {
  binary: CodexBinary;
  home: CodexHome;
  /** 서버가 보고한 CODEX_HOME (요청한 것과 같아야 한다) */
  serverCodexHome: string;
  userAgent: string;
  startupMs: number;
}

export interface ThreadInfo {
  threadId: string;
  model: string;
  sandbox: SandboxPolicy;
  approvalPolicy: AskForApproval;
}

export interface McpServerSummary {
  server: string;
  status: McpServerConnectionStatus | null;
  tools: string[];
  error: string | null;
}

export interface ToolInventory {
  threadId: string;
  /** 설정에서 유도한 내장 도구 계열의 활성 여부. 전부 false여야 한다. */
  builtin: Array<{ name: string; enabled: boolean }>;
  mcp: McpServerSummary[];
}

export class CodexRuntimeError extends Error {
  constructor(
    public readonly kind: 'binary' | 'spawn' | 'handshake' | 'config_mismatch' | 'not_running',
    message: string,
  ) {
    super(message);
    this.name = 'CodexRuntimeError';
  }
}

/** turn/start에 넣을 샌드박스(계획 C1.18: readOnly, networkAccess 기본 false). C1.20부터 사용. */
export const TURN_SANDBOX_POLICY: SandboxPolicy = { type: 'readOnly', networkAccess: false };
export const THREAD_APPROVAL_POLICY: AskForApproval = 'never';

const INHERITED_ENV_KEYS = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'];

/**
 * 자식 프로세스 환경. 부모 환경을 그대로 물려주지 않는다:
 * - OPENAI_*·CODEX_*는 제외(API 키가 있으면 ChatGPT 로그인 대신 쓰이는 것을 막는다).
 * - HOME은 CODEX_HOME 안의 빈 디렉터리(사용자 전역 스킬 루트 차단), CODEX_HOME은 앱 전용 디렉터리.
 */
export function buildChildEnv(parent: NodeJS.ProcessEnv, home: CodexHome): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  env['HOME'] = home.homeDir;
  env['CODEX_HOME'] = home.root;
  return env;
}

const featureMap = (config: Config): Record<string, unknown> => {
  const features = config['features'];
  return typeof features === 'object' && features !== null && !Array.isArray(features)
    ? features
    : {};
};

/** config/read 결과가 앱 규칙과 다른 점. 비어 있어야 시작한다. */
export function verifyEffectiveConfig(config: Config, profile: CodexProfile = 'plain'): string[] {
  const expected = expectedConfigOf(profile);
  const mismatches: string[] = [];
  if (config.approval_policy !== CODEX_TOP_LEVEL_CONFIG.approval_policy) {
    mismatches.push(`approval_policy=${JSON.stringify(config.approval_policy)}`);
  }
  if (config.sandbox_mode !== CODEX_TOP_LEVEL_CONFIG.sandbox_mode) {
    mismatches.push(`sandbox_mode=${JSON.stringify(config.sandbox_mode)}`);
  }
  if (config.web_search !== expected.webSearch) {
    mismatches.push(`web_search=${JSON.stringify(config.web_search)}`);
  }
  const features = featureMap(config);
  for (const name of DISABLED_FEATURES) {
    const want = expected.enabledFeatures.includes(name);
    if (features[name] !== want)
      mismatches.push(`features.${name}=${JSON.stringify(features[name])}`);
  }
  const mcp = config['mcp_servers'];
  if (
    typeof mcp === 'object' &&
    mcp !== null &&
    !Array.isArray(mcp) &&
    Object.keys(mcp).length > 0
  ) {
    mismatches.push(`mcp_servers=${Object.keys(mcp).join(',')} (전역 MCP 서버는 없어야 한다)`);
  }
  return mismatches;
}

/** 설정에서 유도한 내장 도구 계열. 이름은 로그용이다. */
export function builtinToolsOf(config: Config): ToolInventory['builtin'] {
  const f = featureMap(config);
  const on = (...names: string[]): boolean => names.some((n) => f[n] === true);
  return [
    { name: 'shell', enabled: on('shell_tool', 'unified_exec') },
    { name: 'web_search', enabled: config.web_search !== 'disabled' },
    { name: 'browser', enabled: on('browser_use', 'browser_use_external', 'in_app_browser') },
    { name: 'computer_use', enabled: on('computer_use') },
    { name: 'plugins', enabled: on('plugins', 'remote_plugin') },
    { name: 'apps', enabled: on('apps') },
    { name: 'image_generation', enabled: on('image_generation') },
    { name: 'view_image', enabled: on('view_image') },
    { name: 'multi_agent', enabled: on('multi_agent') },
    { name: 'hooks', enabled: on('hooks') },
    { name: 'goals', enabled: on('goals') },
    { name: 'memories', enabled: on('memories') },
  ];
}

export function formatToolInventory(inv: ToolInventory): string {
  const builtin = inv.builtin.map((b) => `${b.name}=${b.enabled ? 'ON' : 'off'}`).join(' ');
  const mcp =
    inv.mcp.length === 0
      ? '(없음)'
      : inv.mcp
          .map(
            (s) =>
              `${s.server}[${s.status ?? 'unknown'}]{${s.tools.join(',')}}${s.error ? ` error=${s.error}` : ''}`,
          )
          .join(' ');
  return `tools thread=${inv.threadId} builtin: ${builtin} | mcp: ${mcp}`;
}

export class CodexRuntime {
  status: CodexRuntimeStatus = 'stopped';
  client: AppServerClient | null = null;
  startInfo: CodexStartInfo | null = null;
  /** 시작 시 config/read로 읽은 유효 설정 */
  effectiveConfig: Config | null = null;
  private readonly log: (line: string) => void;
  private readonly spawnFn: SpawnFn;
  readonly profile: CodexProfile;

  constructor(private readonly options: CodexRuntimeOptions) {
    this.profile = options.profile ?? 'plain';
    this.log = options.log ?? (() => undefined);
    this.spawnFn =
      options.spawn ??
      ((command, args, opts) =>
        spawn(command, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
  }

  async start(): Promise<CodexStartInfo> {
    if (this.client && this.client.state !== 'exited') {
      throw new CodexRuntimeError('spawn', '이미 실행 중입니다');
    }
    this.status = 'starting';
    const t0 = Date.now();
    let binary: CodexBinary;
    try {
      binary = this.options.binary ?? resolveCodexBinary();
    } catch (err) {
      this.status = 'failed';
      throw new CodexRuntimeError('binary', err instanceof Error ? err.message : String(err));
    }
    const home = await ensureCodexHome(join(this.options.userDataPath, 'codex-home'));
    if (home.configWritten) this.log(`config.toml 기록 ${home.configPath}`);

    const profile = this.profile;
    const child = this.spawnFn(binary.path, appServerArgs(profile), {
      env: buildChildEnv(this.options.parentEnv ?? process.env, home),
      cwd: home.workspaceDir,
    });
    const client = new AppServerClient(child, {
      log: (line) => this.log(`client: ${line}`),
      ...(this.options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: this.options.requestTimeoutMs }
        : {}),
    });
    this.client = client;
    this.attachObservers(client);

    try {
      const init = await client.request<InitializeResponse>('initialize', {
        clientInfo: { name: 'paperlens', title: 'PaperLens', version: this.options.appVersion },
        capabilities: { experimentalApi: false, requestAttestation: false },
      } satisfies InitializeParams);
      client.notify('initialized');
      const config = await this.readConfig();
      const mismatches = verifyEffectiveConfig(config, profile);
      if (mismatches.length > 0) {
        throw new CodexRuntimeError(
          'config_mismatch',
          `유효 설정이 앱 규칙과 다릅니다: ${mismatches.join(', ')}`,
        );
      }
      this.effectiveConfig = config;
      this.status = 'running';
      this.startInfo = {
        binary,
        home,
        serverCodexHome: init.codexHome,
        userAgent: init.userAgent,
        startupMs: Date.now() - t0,
      };
      return this.startInfo;
    } catch (err) {
      this.status = 'failed';
      const tail = client.recentStderr().slice(-5);
      await client.close({ graceMs: 1_000, termMs: 1_000 }).catch(() => undefined);
      if (err instanceof CodexRuntimeError) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      throw new CodexRuntimeError(
        'handshake',
        `App Server 초기화 실패: ${detail}${tail.length ? `\nstderr: ${tail.join(' | ')}` : ''}`,
      );
    }
  }

  async readConfig(): Promise<Config> {
    const res = await this.requireClient().request<ConfigReadResponse>('config/read', {
      includeLayers: false,
    } satisfies ConfigReadParams);
    return res.config;
  }

  /** ephemeral·read-only·never 스레드. mcpServers를 주면 그 스레드에만 MCP 서버가 붙는다. */
  async startThread(
    options: { mcpServers?: Record<string, McpServerConfig>; developerInstructions?: string } = {},
  ): Promise<ThreadInfo> {
    const home = this.startInfo?.home;
    if (!home) throw new CodexRuntimeError('not_running', 'App Server가 실행 중이 아닙니다');
    const params: ThreadStartParams = {
      ephemeral: true,
      cwd: home.workspaceDir,
      sandbox: CODEX_TOP_LEVEL_CONFIG.sandbox_mode,
      approvalPolicy: THREAD_APPROVAL_POLICY,
      ...(options.mcpServers ? { config: { mcp_servers: options.mcpServers } } : {}),
      ...(options.developerInstructions !== undefined
        ? { developerInstructions: options.developerInstructions }
        : {}),
    };
    const res = await this.requireClient().request<ThreadStartResponse>('thread/start', params);
    return {
      threadId: res.thread.id,
      model: res.model,
      sandbox: res.sandbox,
      approvalPolicy: res.approvalPolicy,
    };
  }

  /** mcpServerStatus/list. threadId를 주면 그 스레드의 유효 MCP 서버, 없으면 전역(비어 있어야 한다). */
  async listMcpServers(threadId?: string): Promise<McpServerSummary[]> {
    const params: ListMcpServerStatusParams = threadId ? { threadId } : {};
    const res = await this.requireClient().request<ListMcpServerStatusResponse>(
      'mcpServerStatus/list',
      params,
    );
    return res.data.map((s) => ({
      server: s.name,
      status: s.runtimeStatus,
      tools: Object.keys(s.tools).sort(),
      error: s.toolsError,
    }));
  }

  async toolInventory(threadId: string): Promise<ToolInventory> {
    const config = this.effectiveConfig ?? (await this.readConfig());
    return { threadId, builtin: builtinToolsOf(config), mcp: await this.listMcpServers(threadId) };
  }

  async stop(): Promise<ExitInfo | null> {
    const client = this.client;
    if (!client) return null;
    const info = await client.close();
    this.status = 'stopped';
    return info;
  }

  private requireClient(): AppServerClient {
    if (!this.client || this.client.state !== 'running') {
      throw new CodexRuntimeError('not_running', 'App Server가 실행 중이 아닙니다');
    }
    return this.client;
  }

  private attachObservers(client: AppServerClient): void {
    client.onExit((info) => {
      if (info.expected) {
        // 시작 실패(failed) 중의 정리 종료는 상태를 덮어쓰지 않는다.
        if (this.status === 'running') this.status = 'stopped';
        this.log(`app-server 종료 code=${String(info.code)}`);
      } else {
        this.status = 'crashed';
        this.log(
          `app-server 비정상 종료 code=${String(info.code)} signal=${String(info.signal)}${
            info.stderrTail.length ? ` stderr: ${info.stderrTail.slice(-3).join(' | ')}` : ''
          }`,
        );
      }
    });
    client.onServerRequest((req) => {
      this.log(`서버 요청 거절 ${req.method}`);
      return Promise.reject(
        new AppServerError('rpc', `PaperLens는 ${req.method} 요청을 승인하지 않습니다`),
      );
    });
    for (const method of ['configWarning', 'deprecationNotice', 'warning', 'error']) {
      client.onNotification(method, (params) => this.log(`${method}: ${JSON.stringify(params)}`));
    }
    client.onNotification('mcpServer/startupStatus/updated', (params) => {
      const p = params as {
        threadId?: string;
        name?: string;
        status?: string;
        error?: string | null;
      };
      this.log(`mcp ${p.name ?? '?'} ${p.status ?? '?'}${p.error ? ` ${p.error}` : ''}`);
    });
  }
}
