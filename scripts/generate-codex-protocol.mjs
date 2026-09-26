// @openai/codex(고정 버전)의 바이너리로 App Server 프로토콜 TypeScript 바인딩을 재생성한다.
// 사용: npm run codex:generate-ts
// - ChatGPT.app 번들 바이너리가 아닌 node_modules의 바이너리만 사용한다.
// - CODEX_HOME을 임시 디렉터리로 두어 사용자 ~/.codex를 읽거나 만들지 않는다.
// - 출력 디렉터리를 비운 뒤 생성하므로 삭제된 타입이 남지 않는다.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'src', 'main', 'llm', 'codex', 'protocol');
const codexBin = join(root, 'node_modules', '.bin', 'codex');
const prettierBin = join(root, 'node_modules', '.bin', 'prettier');
const codexHome = mkdtempSync(join(tmpdir(), 'paperlens-codex-home-'));

const pkg = JSON.parse(
  readFileSync(join(root, 'node_modules', '@openai', 'codex', 'package.json'), 'utf8'),
);
const pinned = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies[
  '@openai/codex'
];
if (pkg.version !== pinned) {
  throw new Error(
    `설치된 @openai/codex ${pkg.version}이 package.json 고정 버전 ${pinned}과 다릅니다. npm install 후 다시 실행하세요.`,
  );
}

try {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  execFileSync(
    codexBin,
    ['app-server', 'generate-ts', '--out', outDir, '--prettier', prettierBin],
    {
      stdio: 'inherit',
      env: { ...process.env, CODEX_HOME: codexHome },
    },
  );
  writeFileSync(
    join(outDir, 'GENERATED.json'),
    JSON.stringify(
      {
        codexVersion: pkg.version,
        command: 'codex app-server generate-ts (experimental 플래그 없음)',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`generated protocol bindings for @openai/codex ${pkg.version} -> ${outDir}`);
} finally {
  rmSync(codexHome, { recursive: true, force: true });
}
