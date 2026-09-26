import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexBinaryError, resolveCodexBinary } from './codex-binary';
import generated from './protocol/GENERATED.json';

describe('resolveCodexBinary', () => {
  it('이 플랫폼의 npm 바이너리를 찾고 버전이 프로토콜 바인딩과 같다', () => {
    const bin = resolveCodexBinary();
    expect(existsSync(bin.path)).toBe(true);
    expect(bin.version).toBe(generated.codexVersion);
    expect(bin.path).toContain(join('vendor', bin.triple, 'bin'));
    expect(bin.path).toContain('node_modules');
  });

  it('지원하지 않는 플랫폼이면 unsupported_platform', () => {
    expect(() => resolveCodexBinary({ platform: 'freebsd', arch: 'x64' })).toThrowError(
      CodexBinaryError,
    );
    try {
      resolveCodexBinary({ platform: 'freebsd', arch: 'x64' });
    } catch (err) {
      expect((err as CodexBinaryError).kind).toBe('unsupported_platform');
    }
  });

  it('설치 버전이 바인딩 버전과 다르면 실행하지 않는다', () => {
    const root = mkdtempSync(join(tmpdir(), 'paperlens-codex-bin-'));
    const pkgDir = join(root, '@openai', 'codex');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ version: '0.0.0' }));
    try {
      resolveCodexBinary({ platform: 'darwin', arch: 'x64', codexPackageDir: pkgDir });
      throw new Error('unreachable');
    } catch (err) {
      expect((err as CodexBinaryError).kind).toBe('version_mismatch');
    }
  });

  it('플랫폼 패키지의 바이너리가 없으면 missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'paperlens-codex-bin-'));
    const pkgDir = join(root, '@openai', 'codex');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ version: generated.codexVersion }),
    );
    try {
      resolveCodexBinary({ platform: 'darwin', arch: 'arm64', codexPackageDir: pkgDir });
      throw new Error('unreachable');
    } catch (err) {
      expect((err as CodexBinaryError).kind).toBe('missing');
    }
    // 바이너리 파일을 놓으면 찾는다.
    const binDir = join(
      root,
      '@openai',
      'codex-darwin-arm64',
      'vendor',
      'aarch64-apple-darwin',
      'bin',
    );
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'codex'), '');
    const bin = resolveCodexBinary({ platform: 'darwin', arch: 'arm64', codexPackageDir: pkgDir });
    expect(bin.path).toBe(join(binDir, 'codex'));
    expect(bin.packageName).toBe('@openai/codex-darwin-arm64');
  });
});
