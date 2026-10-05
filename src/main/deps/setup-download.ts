import { createHash } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export function trustedDockerUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      u.protocol === 'https:' && u.hostname === 'desktop.docker.com' && !u.username && !u.password
    );
  } catch {
    return false;
  }
}
export function installerChecksum(text: string, filename: string): string {
  const line = text.split(/\r?\n/).find((line) => {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    return match?.[2] === filename;
  });
  if (!line) throw new Error('checksum_unavailable');
  return line.trim().slice(0, 64).toLowerCase();
}
/** Stream to a temporary file, verify the official release checksum, then expose the installer. */
export async function downloadInstaller(
  url: string,
  path: string,
  signal: AbortSignal,
  progress: (percent: number | null) => void,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<void> {
  if (!trustedDockerUrl(url)) throw new Error('untrusted_download');
  const response = await fetcher(url, { signal });
  if (!response.ok || !response.body || !trustedDockerUrl(response.url || url))
    throw new Error('download_failed');
  try {
    const finalUrl = new URL(response.url || url);
    const filename = decodeURIComponent(finalUrl.pathname.split('/').at(-1) ?? '');
    const checksumUrl = new URL('checksums.txt', finalUrl).href;
    const check = await fetcher(checksumUrl, { signal });
    if (!check.ok || !trustedDockerUrl(check.url || checksumUrl)) {
      await response.body.cancel();
      throw new Error('checksum_unavailable');
    }
    const checksumText = await check.text();
    if (checksumText.length > 65536) {
      await response.body.cancel();
      throw new Error('checksum_unavailable');
    }
    const expected = installerChecksum(checksumText, filename);
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.part`;
    const file = await open(temp, 'w', 0o600);
    const hash = createHash('sha256');
    const total = Number(response.headers.get('content-length'));
    let bytes = 0;
    try {
      for await (const data of response.body as ReadableStream<Uint8Array>) {
        signal.throwIfAborted();
        hash.update(data);
        bytes += data.length;
        if (bytes > 3 * 1024 ** 3) throw new Error('download_too_large');
        await file.writeFile(data);
        progress(total > 0 ? Math.min(99, Math.floor((bytes / total) * 100)) : null);
      }
      signal.throwIfAborted();
      if (hash.digest('hex') !== expected) throw new Error('checksum_mismatch');
      await file.close();
      await rename(temp, path);
      progress(100);
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(temp, { force: true });
      throw error;
    }
  } finally {
    if (!response.body.locked) await response.body.cancel().catch(() => undefined);
  }
}
