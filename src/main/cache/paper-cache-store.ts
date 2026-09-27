import { promises as fs, type Dirent } from 'node:fs';
import { join, relative } from 'node:path';
import {
  SCHEMA_VERSION,
  validateCacheDocument,
  type CacheSchemaName,
  type Manifest,
  type SchemaTypeMap,
} from '@shared/schema';
import { writeFileAtomic, cleanupTempFiles } from './atomic-file';
import { sha256Hex, stableStringify } from './hash';

export class CacheReadError extends Error {
  constructor(
    public readonly path: string,
    public readonly reason: 'missing' | 'invalid_json' | 'schema' | 'hash_mismatch',
    public readonly details: string[] = [],
  ) {
    super(`${reason}: ${path}${details.length ? ` (${details.join('; ')})` : ''}`);
    this.name = 'CacheReadError';
  }
}

/**
 * <root>/papers/<sha256>/ 하위의 캐시 파일을 스키마 검증과 원자 교체로 읽고 쓴다.
 * manifest.files에 파일별 해시를 기록해 재시작 시 검증할 수 있게 한다.
 */
export class PaperCacheStore {
  constructor(private readonly root: string) {}

  paperDir(pdfSha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(pdfSha256)) throw new Error(`invalid sha256: ${pdfSha256}`);
    return join(this.root, 'papers', pdfSha256);
  }

  manifestPath(pdfSha256: string): string {
    return join(this.paperDir(pdfSha256), 'manifest.json');
  }

  extractionPath(
    pdfSha256: string,
    revision: string,
    file: 'document.json' | 'source-map.json' | 'original.tei.xml',
  ): string {
    return join(this.paperDir(pdfSha256), 'extraction', revision, file);
  }

  generationPath(
    pdfSha256: string,
    generationId: string,
    file: 'context.json' | 'research.json' | 'budget.json' | `chunks/${string}.json`,
  ): string {
    return join(this.paperDir(pdfSha256), 'generations', generationId, file);
  }

  /** 실패한 출력 등 진단 자료. 캐시 결과가 아니므로 manifest.files에 기록하지 않는다. */
  diagnosticsPath(pdfSha256: string, generationId: string, name: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`invalid diagnostics name: ${name}`);
    return join(this.paperDir(pdfSha256), 'generations', generationId, 'diagnostics', name);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  /** 검증 → 직렬화 → 원자 쓰기. 반환값은 파일 sha256. */
  async writeJson<N extends CacheSchemaName>(
    name: N,
    path: string,
    value: SchemaTypeMap[N],
  ): Promise<string> {
    const result = validateCacheDocument(name, value);
    if (!result.ok) throw new Error(`schema ${name} 검증 실패: ${result.errors.join('; ')}`);
    return writeFileAtomic(path, stableStringify(value) + '\n');
  }

  /** 읽기 → JSON 파싱 → 스키마 검증. expectedSha256이 있으면 해시도 대조한다. */
  async readJson<N extends CacheSchemaName>(
    name: N,
    path: string,
    expectedSha256?: string,
  ): Promise<SchemaTypeMap[N]> {
    let raw: Buffer;
    try {
      raw = await fs.readFile(path);
    } catch {
      throw new CacheReadError(path, 'missing');
    }
    if (expectedSha256 && sha256Hex(raw) !== expectedSha256) {
      throw new CacheReadError(path, 'hash_mismatch');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch (e) {
      throw new CacheReadError(path, 'invalid_json', [String(e)]);
    }
    const result = validateCacheDocument(name, parsed);
    if (!result.ok) throw new CacheReadError(path, 'schema', result.errors);
    return result.value;
  }

  async writeText(path: string, content: string | Buffer): Promise<string> {
    return writeFileAtomic(path, content);
  }

  /** 논문 디렉터리와 초기 manifest를 만든다. 이미 있으면 기존 manifest를 돌려준다. */
  async initPaper(pdfSha256: string, now = new Date()): Promise<Manifest> {
    const path = this.manifestPath(pdfSha256);
    if (await this.exists(path)) return this.readJson('manifest', path);
    const manifest: Manifest = {
      schemaVersion: SCHEMA_VERSION,
      pdfSha256,
      state: 'imported',
      currentExtractionRevision: null,
      currentGenerationId: null,
      generations: [],
      files: [],
      usage: { logicalJobs: 0, turnCount: 0, elapsedMs: 0 },
      errors: [],
      updatedAt: now.toISOString(),
    };
    await this.writeJson('manifest', path, manifest);
    return manifest;
  }

  async readManifest(pdfSha256: string): Promise<Manifest> {
    return this.readJson('manifest', this.manifestPath(pdfSha256));
  }

  /**
   * manifest를 갱신한다. 파일 해시 등록은 manifest보다 먼저 결과 파일을 확정한 뒤 호출한다
   * (PLAN 8.3: 결과 파일과 해시 확정 → manifest에서 완료 표시).
   */
  async updateManifest(
    pdfSha256: string,
    mutate: (m: Manifest) => void,
    now = new Date(),
  ): Promise<Manifest> {
    const manifest = await this.readManifest(pdfSha256);
    mutate(manifest);
    manifest.updatedAt = now.toISOString();
    await this.writeJson('manifest', this.manifestPath(pdfSha256), manifest);
    return manifest;
  }

  /** manifest.files에 (상대경로, 해시)를 기록하거나 갱신한다. */
  recordFile(manifest: Manifest, pdfSha256: string, absolutePath: string, sha256: string): void {
    const rel = relative(this.paperDir(pdfSha256), absolutePath);
    const existing = manifest.files.find((f) => f.path === rel);
    if (existing) existing.sha256 = sha256;
    else manifest.files.push({ path: rel, sha256 });
  }

  /** manifest.files의 모든 파일이 존재하고 해시가 맞는지 검사한다. 어긋난 항목을 돌려준다. */
  async verifyFiles(
    pdfSha256: string,
  ): Promise<{ path: string; problem: 'missing' | 'hash_mismatch' }[]> {
    const manifest = await this.readManifest(pdfSha256);
    const problems: { path: string; problem: 'missing' | 'hash_mismatch' }[] = [];
    for (const f of manifest.files) {
      const abs = join(this.paperDir(pdfSha256), f.path);
      try {
        const raw = await fs.readFile(abs);
        if (sha256Hex(raw) !== f.sha256) problems.push({ path: f.path, problem: 'hash_mismatch' });
      } catch {
        problems.push({ path: f.path, problem: 'missing' });
      }
    }
    return problems;
  }

  /** 재시작 시 남은 임시 파일을 정리한다. */
  async cleanupTemp(pdfSha256: string): Promise<string[]> {
    const dir = this.paperDir(pdfSha256);
    const removed: string[] = [];
    const walk = async (d: string): Promise<void> => {
      removed.push(...(await cleanupTempFiles(d)).map((n) => join(relative(dir, d), n)));
      let entries: Dirent[];
      try {
        entries = await fs.readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) if (e.isDirectory()) await walk(join(d, e.name));
    };
    await walk(dir);
    return removed;
  }
}
