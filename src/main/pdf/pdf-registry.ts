import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import type { OpenedPdf } from '@shared/ipc';
import { sha256File } from '../cache/hash';
import type { PaperCacheStore } from '../cache/paper-cache-store';

/**
 * 열린 PDF를 해시로 식별해 캐시 디렉터리를 만들고, renderer가 바이트를 요청할 수 있게 경로를 기억한다.
 * 원본 파일은 읽기만 하고 절대 수정·이동하지 않는다.
 */
export class PdfRegistry {
  private readonly paths = new Map<string, string>();

  constructor(private readonly store: PaperCacheStore) {}

  async register(originalPath: string): Promise<OpenedPdf> {
    const stat = await fs.stat(originalPath);
    const pdfSha256 = await sha256File(originalPath);
    await this.store.initPaper(pdfSha256);
    this.paths.set(pdfSha256, originalPath);
    return { pdfSha256, fileName: basename(originalPath), originalPath, byteLength: stat.size };
  }

  /** 등록된 해시에 대해서만 바이트를 준다. 임의 경로 읽기를 renderer에 허용하지 않는다. */
  async readBytes(pdfSha256: string): Promise<Uint8Array> {
    const path = this.paths.get(pdfSha256);
    if (!path) throw new Error(`등록되지 않은 PDF: ${pdfSha256}`);
    return new Uint8Array(await fs.readFile(path));
  }
}
