import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadInstaller, installerChecksum, trustedDockerUrl } from './setup-download';
import { installerUrl } from './setup-platform';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function target() {
  const dir = await mkdtemp(join(tmpdir(), 'setup-download-'));
  dirs.push(dir);
  return join(dir, 'Docker.dmg');
}
const data = 'fake installer bytes';
const digest = createHash('sha256').update(data).digest('hex');
function mockFetch(checksum = digest) {
  return vi.fn((url: string) => {
    if (url.endsWith('checksums.txt'))
      return Promise.resolve(new Response(`${checksum} *Docker.dmg\n`));
    const response = new Response(data, { headers: { 'content-length': String(data.length) } });
    Object.defineProperty(response, 'url', {
      value: 'https://desktop.docker.com/mac/main/arm64/123/checksums/../Docker.dmg',
    });
    return Promise.resolve(response);
  });
}
describe('verified official installer download', () => {
  it('checks the resolved release checksum before publishing installer', async () => {
    const file = await target();
    const fetcher = mockFetch();
    const progress = vi.fn();
    await downloadInstaller(
      installerUrl('darwin', 'arm64'),
      file,
      new AbortController().signal,
      progress,
      fetcher,
    );
    expect(await readFile(file, 'utf8')).toBe(data);
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      'https://desktop.docker.com/mac/main/arm64/123/checksums.txt',
    );
    expect(progress).toHaveBeenLastCalledWith(100);
  });
  it('removes partial files and never publishes a corrupt installer', async () => {
    const file = await target();
    await expect(
      downloadInstaller(
        installerUrl('darwin', 'x64'),
        file,
        new AbortController().signal,
        () => {},
        mockFetch('0'.repeat(64)),
      ),
    ).rejects.toThrow('checksum_mismatch');
    expect(await readdir(dirs.at(-1)!)).toEqual([]);
  });
  it('does not expose an installer after cancellation', async () => {
    const file = await target();
    const controller = new AbortController();
    await expect(
      downloadInstaller(
        installerUrl('darwin', 'x64'),
        file,
        controller.signal,
        () => controller.abort(),
        mockFetch(),
      ),
    ).rejects.toThrow();
    expect(await readdir(dirs.at(-1)!)).toEqual([]);
  });
  it('only accepts exact official HTTPS host and matching checksum filename', async () => {
    expect(trustedDockerUrl('https://desktop.docker.com.evil.test/a')).toBe(false);
    expect(trustedDockerUrl('http://desktop.docker.com/a')).toBe(false);
    const fetcher = vi.fn();
    await expect(
      downloadInstaller(
        'https://other.test/install',
        '/unused',
        new AbortController().signal,
        () => {},
        fetcher,
      ),
    ).rejects.toThrow('untrusted_download');
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      installerChecksum(`${digest} *Docker Desktop Installer.exe`, 'Docker Desktop Installer.exe'),
    ).toBe(digest);
    expect(() => installerChecksum(`${digest} *other.exe`, 'Docker.dmg')).toThrow();
    expect(() => installerUrl('win32', 'arm64')).toThrow('unsupported_platform');
  });
});
