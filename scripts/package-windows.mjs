import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, Platform, Arch } from 'electron-builder';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const electron = JSON.parse(
  await readFile(join(root, 'node_modules/electron/package.json'), 'utf8'),
);
const output = join(root, 'dist/windows');
await mkdir(output, { recursive: true });
const staging = await mkdtemp(join(root, 'dist/.windows-build-'));
const codexRelative =
  'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe';

async function assertWindowsX64(file) {
  const bytes = await readFile(file);
  const pe = bytes.readUInt32LE(0x3c);
  if (
    bytes.toString('ascii', 0, 2) !== 'MZ' ||
    bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0' ||
    bytes.readUInt16LE(pe + 4) !== 0x8664
  ) {
    throw new Error(`Windows x64 실행 파일이 아닙니다: ${file}`);
  }
}

try {
  // Install target-platform dependencies separately so macOS development stays intact.
  const appManifest = { ...manifest };
  delete appManifest.build;
  await writeFile(join(staging, 'package.json'), JSON.stringify(appManifest, null, 2));
  await cp(join(root, 'package-lock.json'), join(staging, 'package-lock.json'));
  await cp(join(root, 'out'), join(staging, 'out'), { recursive: true });
  if (!process.env.npm_execpath) throw new Error('npm run package:win으로 실행하세요.');
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        process.env.npm_execpath,
        'ci',
        '--os=win32',
        '--cpu=x64',
        '--omit=dev',
        '--include=optional',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
      { cwd: staging, stdio: 'inherit' },
    );
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Windows 의존성 설치 실패 (${code})`)),
    );
  });
  await assertWindowsX64(join(staging, codexRelative));
  delete appManifest.devDependencies;
  delete appManifest.scripts;
  await writeFile(join(staging, 'package.json'), JSON.stringify(appManifest, null, 2));

  await build({
    projectDir: staging,
    targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
    publish: 'never',
    config: {
      appId: manifest.build.appId,
      productName: manifest.build.productName,
      directories: { output },
      files: manifest.build.files,
      asar: false,
      npmRebuild: false,
      electronVersion: electron.version,
      win: { signExecutable: false },
      nsis: {
        artifactName: '${productName}-${version}-win-${arch}-Setup.${ext}',
        oneClick: false,
        perMachine: false,
        allowToChangeInstallationDirectory: true,
        installerLanguages: ['ko_KR', 'en_US'],
        language: '1042',
        createDesktopShortcut: true,
      },
      afterPack: async ({ appOutDir }) => {
        await assertWindowsX64(join(appOutDir, `${manifest.build.productName}.exe`));
        await assertWindowsX64(join(appOutDir, 'resources/app', codexRelative));
      },
    },
  });
  console.log(`Windows 설치 파일: ${output}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
