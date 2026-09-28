import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../../cache/atomic-file';

/**
 * 앱 전용 CODEX_HOME (COMMIT_PLAN C1.18, docs/environment.md "Codex 런타임 고정 방침").
 * - `userData/codex-home/` 아래에 config.toml·auth.json·상태 DB가 놓인다. 전역 ~/.codex는 읽지 않는다.
 * - config.toml은 앱이 매번 생성한다(사용자 편집 없음). `--strict-config`로 띄우므로 오타는 시작 실패로 드러난다.
 * - `home/`은 자식 프로세스의 HOME. 비워 두어 `~/.agents/skills` 같은 사용자 전역 자산이 프롬프트에 들어가지 않게 한다(실측:
 *   HOME을 바꾸지 않으면 `$HOME/.agents/skills`가 스킬 루트로 붙는다).
 * - `workspace/`는 스레드 cwd. 비어 있어 AGENTS.md·프로젝트 설정 계층이 없다.
 */
export const CODEX_TOP_LEVEL_CONFIG = {
  web_search: 'disabled',
  approval_policy: 'never',
  sandbox_mode: 'read-only',
} as const;

/**
 * 끄는 기능 플래그. 계획(C1.18)의 7종에 더해, 0.157.1 `codex features list`에서 stable=true인 도구·외부 연결 기능을 끈다.
 * `[features].web_search`는 0.157.1에서 deprecated(최상위 `web_search`로 대체)라 넣지 않는다.
 */
export const DISABLED_FEATURES = [
  // 계획 명시
  'shell_tool',
  'unified_exec',
  'apps',
  'multi_agent',
  'goals',
  'hooks',
  // 플러그인·마켓플레이스 (켜 두면 시작 시 plugins git clone이 일어난다 — 실측)
  'plugins',
  'remote_plugin',
  'recommended_plugins',
  'plugin_sharing',
  'skill_search',
  'skill_mcp_dependency_install',
  // 브라우저·컴퓨터 사용·이미지·기타 도구
  'browser_use',
  'browser_use_external',
  'computer_use',
  'image_generation',
  'in_app_browser',
  'code_mode_host',
  'memories',
  'tool_suggest',
  'sleep_tool',
  'view_image',
  'worktrees',
  'workspace_dependencies',
  'realtime_conversation',
  // 데몬·앱 통합
  'daemon_auto_start',
  'in_app_chat',
  'in_app_dictation',
  'in_app_local_automation',
  'in_app_updates',
  'auth_elicitation',
] as const;

export type DisabledFeature = (typeof DISABLED_FEATURES)[number];

/**
 * 실행 방식(PLAN 3.3.1). `plain`은 번역과 도구 없는 패스용으로 검색이 없다.
 * `research`는 조사 전용 프로세스다. 내장 검색을 쓰려면 `code_mode_host` 기능과 `web_search = "live"`를
 * 프로세스 실행 인자로 켜야 한다. 스레드별 설정으로는 켜지지 않는다(0.157.1 실측, docs/search-provider-eval.md).
 * config.toml은 두 방식이 함께 쓰므로 바꾸지 않고 실행 인자로 덮어쓴다.
 */
export type CodexProfile = 'plain' | 'research';

export const RESEARCH_ENABLED_FEATURES = ['code_mode_host'] as const satisfies DisabledFeature[];
export const RESEARCH_WEB_SEARCH = 'live';

/** 방식별 기대 설정. 유효 설정 검증과 실행 인자가 같은 값을 본다. */
export function expectedConfigOf(profile: CodexProfile): {
  webSearch: string;
  enabledFeatures: readonly DisabledFeature[];
} {
  return profile === 'research'
    ? { webSearch: RESEARCH_WEB_SEARCH, enabledFeatures: RESEARCH_ENABLED_FEATURES }
    : { webSearch: CODEX_TOP_LEVEL_CONFIG.web_search, enabledFeatures: [] };
}

/** `codex app-server`에 줄 인자. */
export function appServerArgs(profile: CodexProfile): string[] {
  const expected = expectedConfigOf(profile);
  const overrides =
    profile === 'research'
      ? [
          ...expected.enabledFeatures.flatMap((name) => ['-c', `features.${name}=true`]),
          '-c',
          `web_search="${expected.webSearch}"`,
        ]
      : [];
  return ['app-server', ...overrides, '--strict-config', '--listen', 'stdio://'];
}

export function renderConfigToml(): string {
  const lines = [
    '# PaperLens가 생성하는 파일입니다. 앱을 시작할 때마다 덮어씁니다 (편집하지 마세요).',
    `web_search = "${CODEX_TOP_LEVEL_CONFIG.web_search}"`,
    `approval_policy = "${CODEX_TOP_LEVEL_CONFIG.approval_policy}"`,
    `sandbox_mode = "${CODEX_TOP_LEVEL_CONFIG.sandbox_mode}"`,
    '',
    '[features]',
    ...DISABLED_FEATURES.map((name) => `${name} = false`),
    '',
  ];
  return lines.join('\n');
}

export interface CodexHome {
  /** CODEX_HOME */
  root: string;
  configPath: string;
  /** 자식 프로세스의 HOME (빈 디렉터리) */
  homeDir: string;
  /** 스레드 cwd (빈 디렉터리) */
  workspaceDir: string;
}

/** 디렉터리를 만들고 config.toml을 앱 규칙대로 맞춘다. 내용이 같으면 다시 쓰지 않는다. */
export async function ensureCodexHome(
  root: string,
): Promise<CodexHome & { configWritten: boolean }> {
  const home: CodexHome = {
    root,
    configPath: join(root, 'config.toml'),
    homeDir: join(root, 'home'),
    workspaceDir: join(root, 'workspace'),
  };
  await fs.mkdir(home.root, { recursive: true, mode: 0o700 });
  await fs.mkdir(home.homeDir, { recursive: true });
  await fs.mkdir(home.workspaceDir, { recursive: true });
  const wanted = renderConfigToml();
  const current = await fs.readFile(home.configPath, 'utf8').catch(() => null);
  const configWritten = current !== wanted;
  if (configWritten) await writeFileAtomic(home.configPath, wanted);
  return { ...home, configWritten };
}
