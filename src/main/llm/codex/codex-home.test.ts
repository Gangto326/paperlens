import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DISABLED_FEATURES, ensureCodexHome, renderConfigToml } from './codex-home';

describe('codex-home', () => {
  it('config.toml에 계획(C1.18)의 상위 키와 끄는 기능이 모두 들어 있다', () => {
    const toml = renderConfigToml();
    expect(toml).toContain('web_search = "disabled"');
    expect(toml).toContain('approval_policy = "never"');
    expect(toml).toContain('sandbox_mode = "read-only"');
    expect(toml).toContain('[features]');
    for (const name of [
      'shell_tool',
      'unified_exec',
      'apps',
      'multi_agent',
      'goals',
      'hooks',
      'plugins',
    ]) {
      expect(DISABLED_FEATURES).toContain(name);
      expect(toml).toContain(`${name} = false`);
    }
    // deprecated 키는 쓰지 않는다 (0.157.1: `[features].web_search` → 최상위 web_search).
    expect(toml).not.toMatch(/^web_search = false/m);
    expect(toml).not.toMatch(/\[mcp_servers|\[marketplaces|\[plugins|\[skills/);
  });

  it('디렉터리와 config.toml을 만들고, 같으면 다시 쓰지 않으며, 바뀌면 되돌린다', async () => {
    const root = join(await fs.mkdtemp(join(tmpdir(), 'paperlens-codex-home-')), 'codex-home');
    const first = await ensureCodexHome(root);
    expect(first.configWritten).toBe(true);
    expect(first.homeDir).toBe(join(root, 'home'));
    expect(first.workspaceDir).toBe(join(root, 'workspace'));
    for (const dir of [first.root, first.homeDir, first.workspaceDir]) {
      expect((await fs.stat(dir)).isDirectory()).toBe(true);
    }
    expect(await fs.readFile(first.configPath, 'utf8')).toBe(renderConfigToml());

    const second = await ensureCodexHome(root);
    expect(second.configWritten).toBe(false);

    await fs.writeFile(first.configPath, 'sandbox_mode = "danger-full-access"\n');
    const third = await ensureCodexHome(root);
    expect(third.configWritten).toBe(true);
    expect(await fs.readFile(first.configPath, 'utf8')).toBe(renderConfigToml());
    expect(await fs.readdir(root)).not.toContainEqual(expect.stringMatching(/\.tmp$/));
  });
});
