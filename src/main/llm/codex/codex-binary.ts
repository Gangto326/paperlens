import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import generated from './protocol/GENERATED.json';

/**
 * 앱이 띄울 Codex 바이너리를 npm `@openai/codex`(고정 버전)에서 찾는다 (COMMIT_PLAN C1.17·C1.18).
 * - `bin/codex.js`가 하는 일과 같은 규칙: 플랫폼별 optional dependency 패키지의 `vendor/<triple>/bin/codex`.
 * - ChatGPT.app 번들 바이너리나 PATH의 codex는 쓰지 않는다.
 * - 설치된 버전이 프로토콜 바인딩(GENERATED.json)을 만든 버전과 다르면 실행하지 않는다.
 */
const PLATFORM_PACKAGES: Record<string, { packageName: string; triple: string }> = {
  'linux-x64': { packageName: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl' },
  'linux-arm64': { packageName: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' },
  'darwin-x64': { packageName: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin' },
  'darwin-arm64': { packageName: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin' },
  'win32-x64': { packageName: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
  'win32-arm64': { packageName: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' },
};

export interface CodexBinary {
  path: string;
  /** 설치된 @openai/codex 버전 (GENERATED.json과 같아야 한다) */
  version: string;
  packageName: string;
  triple: string;
}

export class CodexBinaryError extends Error {
  constructor(
    public readonly kind: 'unsupported_platform' | 'missing' | 'version_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'CodexBinaryError';
  }
}

export interface ResolveCodexBinaryOptions {
  platform?: string;
  arch?: string;
  /** `@openai/codex` 패키지 디렉터리 (기본: node_modules에서 해석) */
  codexPackageDir?: string;
  /** 바인딩을 생성한 버전 (기본: protocol/GENERATED.json) */
  expectedVersion?: string;
}

function defaultCodexPackageDir(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve('@openai/codex/package.json'));
}

export function resolveCodexBinary(options: ResolveCodexBinaryOptions = {}): CodexBinary {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const target = PLATFORM_PACKAGES[`${platform}-${arch}`];
  if (!target) {
    throw new CodexBinaryError(
      'unsupported_platform',
      `지원하지 않는 플랫폼: ${platform} (${arch})`,
    );
  }
  const codexPackageDir = options.codexPackageDir ?? defaultCodexPackageDir();
  const pkg = JSON.parse(readFileSync(join(codexPackageDir, 'package.json'), 'utf8')) as {
    version?: string;
  };
  const version = pkg.version ?? 'unknown';
  const expected = options.expectedVersion ?? generated.codexVersion;
  if (version !== expected) {
    throw new CodexBinaryError(
      'version_mismatch',
      `설치된 @openai/codex ${version}이 프로토콜 바인딩 버전 ${expected}과 다릅니다. npm install 후 npm run codex:generate-ts`,
    );
  }
  // 플랫폼 패키지는 @openai/codex 옆(같은 node_modules/@openai/)에 설치된다. 호이스팅이 다르면 require.resolve로 보완한다.
  const exe = platform === 'win32' ? 'codex.exe' : 'codex';
  const candidates = [join(dirname(codexPackageDir), target.packageName.split('/')[1] ?? '')];
  if (!options.codexPackageDir) {
    try {
      const require = createRequire(import.meta.url);
      candidates.push(dirname(require.resolve(`${target.packageName}/package.json`)));
    } catch {
      // optional dependency가 없으면 아래 missing 오류로 알린다.
    }
  }
  for (const dir of candidates) {
    const path = join(dir, 'vendor', target.triple, 'bin', exe);
    if (existsSync(path))
      return { path, version, packageName: target.packageName, triple: target.triple };
  }
  throw new CodexBinaryError(
    'missing',
    `${target.packageName}의 바이너리를 찾지 못했습니다 (${candidates.join(', ')}). npm install을 다시 실행하세요.`,
  );
}
