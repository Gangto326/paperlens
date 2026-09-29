import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { stableStringify } from '../cache/hash';
import type { PaperCacheStore } from '../cache/paper-cache-store';
import type { LlmJobEvent, LlmJobResult } from '../llm/job';
import type { ResearchTrace } from '../llm/research-trace';

/**
 * 돌던 작업의 출력 보존(COMMIT_PLAN M3 P2). 요청이 도는 동안 받은 출력을 세대 폴더의 `inflight/`에 둔다.
 * 완료 결과(`chunks/`, `context.json`, `research.json`)와 섞지 않는다. manifest.files에도 적지 않는다.
 *
 * 작업 하나에 파일 셋:
 * - `<jobId>.meta.json`: 어느 작업의 출력인지(단계, 단위, 입력 해시, 대상 id). 요청을 보내기 전에 쓴다.
 * - `<jobId>.txt`: 받은 출력 글. 도는 동안에는 `flushMs`마다 덧붙인다. 작업이 끝나면 끝난 때의 글로 바꿔 쓴다.
 * - `<jobId>.trace.json`: 조사 작업의 검색 기록. 검색이 하나 끝날 때마다 그때까지의 기록으로 바꿔 쓴다.
 *
 * 남는 경우: 한도 초과, 로그인 만료, 제한 시간처럼 작업이 실패로 끝난 때는 끝난 때의 글이 남는다.
 * 앱 종료와 강제 종료에서는 마지막으로 덧붙인 데까지 남는다. 이 폴더의 파일은 fsync하지 않는다.
 * 요청마다 여러 번 쓰는 자리라 완료 결과처럼 디스크에 확정하면 느리다. 운영체제에 넘긴 글은 앱이 죽어도 남는다.
 * 전원이 끊기면 마지막 조각이 없을 수 있다. 그때는 그 부분을 다시 요청할 뿐이고 완료 결과는 영향을 받지 않는다.
 *
 * 여기 있는 글은 검증 전의 글이다. 읽는 쪽이 검증기를 거친 뒤에만 결과로 쓴다.
 * 출력은 메시지 하나만 남긴다. 작업 도중 새 메시지가 시작되면 앞 메시지의 글은 지운다(마지막 메시지가 답이다).
 */
export type InflightStage = 'translate' | 'concept_research' | 'context';

export interface InflightMeta {
  version: 1;
  jobId: string;
  stage: InflightStage;
  /** 청크 id, 조사 묶음의 이름 등 그 단계의 작업 단위 */
  unitId: string;
  /** 그 단위에서 몇 번째 요청인지 */
  attempt: number;
  /** 출력이 속한 입력의 해시. 다시 진행할 때 입력이 같아야 쓴다 */
  inputHash: string;
  /** 요청에 넣은 대상의 원래 id */
  targetIds: string[];
  /** 요청에 넣은 문맥 문장의 원래 id */
  neighborIds: string[];
  startedAt: string;
  endedAt: string | null;
  /** 작업의 결과 종류. 끝나지 못했으면 null */
  outcome: string | null;
}

export interface InflightEntry {
  meta: InflightMeta;
  text: string;
  trace: ResearchTrace | null;
}

export const INFLIGHT_FLUSH_MS = 1_000;

/** 임시 파일에 쓰고 이름을 바꾼다. 읽는 쪽이 쓰다 만 파일을 보지 않는다. fsync는 하지 않는다. */
async function replaceFile(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, path);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

const JOB_ID = /^[A-Za-z0-9._-]+$/;
const STAGES: readonly string[] = ['translate', 'concept_research', 'context'];

const isMeta = (value: unknown): value is InflightMeta => {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  const strings = (v: unknown): boolean =>
    Array.isArray(v) && v.every((x) => typeof x === 'string');
  return (
    m['version'] === 1 &&
    typeof m['jobId'] === 'string' &&
    JOB_ID.test(m['jobId']) &&
    typeof m['stage'] === 'string' &&
    STAGES.includes(m['stage']) &&
    typeof m['unitId'] === 'string' &&
    typeof m['attempt'] === 'number' &&
    typeof m['inputHash'] === 'string' &&
    strings(m['targetIds']) &&
    strings(m['neighborIds']) &&
    typeof m['startedAt'] === 'string'
  );
};

export class InflightRecorder {
  private pending = '';
  private truncate = true;
  private item = 0;
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(
    private readonly dir: string,
    private readonly meta: InflightMeta,
    private readonly now: () => Date,
    private readonly log: (line: string) => void,
    flushMs: number,
  ) {
    this.timer = setInterval(() => void this.flush(), flushMs);
    this.timer.unref();
  }

  private get textPath(): string {
    return join(this.dir, `${this.meta.jobId}.txt`);
  }

  private get tracePath(): string {
    return join(this.dir, `${this.meta.jobId}.trace.json`);
  }

  /** 작업 이벤트를 받는다. 출력 조각을 모으고 검색 기록을 쓴다. 던지지 않는다. */
  onEvent(event: LlmJobEvent): void {
    if (this.closed || event.jobId !== this.meta.jobId) return;
    if (event.type === 'research') {
      const body = `${stableStringify(event.trace)}\n`;
      this.chain = this.chain
        .then(() => replaceFile(this.tracePath, body))
        .then(() => undefined)
        .catch((err: unknown) =>
          this.log(`inflight ${this.meta.jobId} 검색 기록 쓰기 실패: ${String(err)}`),
        );
      return;
    }
    if (event.type !== 'output') return;
    if (event.item !== this.item) {
      this.item = event.item;
      this.pending = '';
      this.truncate = true;
    }
    this.pending += event.delta;
  }

  /** 모아 둔 조각을 파일에 넘긴다. 쓰기는 하나씩 차례로 한다. */
  flush(): Promise<void> {
    if (this.closed || (this.pending === '' && !this.truncate)) return this.chain;
    const text = this.pending;
    const truncate = this.truncate;
    this.pending = '';
    this.truncate = false;
    this.chain = this.chain
      .then(() =>
        truncate ? fs.writeFile(this.textPath, text) : fs.appendFile(this.textPath, text),
      )
      .catch((err: unknown) => this.log(`inflight ${this.meta.jobId} 쓰기 실패: ${String(err)}`));
    return this.chain;
  }

  /**
   * 작업이 결과를 돌려준 때 부른다. 끝난 때의 글로 파일을 바꿔 쓴다.
   * 끝나지 못한 메시지의 글이 있으면 그것을, 없으면 끝난 메시지의 글을 쓴다. 던지지 않는다.
   */
  async finish(result: LlmJobResult): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    // 끝난 때의 글을 통째로 쓰므로 넘기지 않은 조각은 버린다.
    this.pending = '';
    this.truncate = false;
    await this.chain;
    const text = result.ok ? result.rawText : (result.partialText ?? result.rawText ?? '');
    try {
      await replaceFile(this.textPath, text);
      if (result.research) {
        await replaceFile(this.tracePath, `${stableStringify(result.research)}\n`);
      }
      const meta: InflightMeta = {
        ...this.meta,
        endedAt: this.now().toISOString(),
        outcome: result.ok ? 'ok' : result.kind,
      };
      await replaceFile(
        join(this.dir, `${this.meta.jobId}.meta.json`),
        `${stableStringify(meta)}\n`,
      );
    } catch (err) {
      this.log(`inflight ${this.meta.jobId} 마무리 실패: ${String(err)}`);
    }
  }
}

export class InflightStore {
  private readonly dir: string;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly flushMs: number;

  constructor(
    store: PaperCacheStore,
    pdfSha256: string,
    generationId: string,
    options: { now?: () => Date; log?: (line: string) => void; flushMs?: number } = {},
  ) {
    this.dir = store.inflightDir(pdfSha256, generationId);
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
    this.flushMs = options.flushMs ?? INFLIGHT_FLUSH_MS;
  }

  /**
   * 요청을 보내기 전에 부른다. 기록을 시작하지 못하면 null을 돌려준다. 보존에 실패해도 작업은 막지 않는다.
   */
  async begin(
    meta: Omit<InflightMeta, 'version' | 'startedAt' | 'endedAt' | 'outcome'>,
  ): Promise<InflightRecorder | null> {
    if (!JOB_ID.test(meta.jobId)) {
      this.log(`inflight 작업 id를 파일 이름으로 쓸 수 없음: ${meta.jobId}`);
      return null;
    }
    const full: InflightMeta = {
      ...meta,
      version: 1,
      startedAt: this.now().toISOString(),
      endedAt: null,
      outcome: null,
    };
    try {
      await replaceFile(join(this.dir, `${meta.jobId}.meta.json`), `${stableStringify(full)}\n`);
      await fs.rm(join(this.dir, `${meta.jobId}.trace.json`), { force: true });
      await fs.writeFile(join(this.dir, `${meta.jobId}.txt`), '');
    } catch (err) {
      this.log(`inflight ${meta.jobId} 시작 실패: ${String(err)}`);
      return null;
    }
    return new InflightRecorder(this.dir, full, this.now, this.log, this.flushMs);
  }

  /** 그 단계와 단위의 기록을 요청 순서로 돌려준다. 읽지 못하는 기록은 건너뛴다. */
  async list(stage: InflightStage, unitId?: string): Promise<InflightEntry[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const entries: InflightEntry[] = [];
    for (const name of names.filter((n) => n.endsWith('.meta.json')).sort()) {
      const jobId = name.slice(0, -'.meta.json'.length);
      try {
        const meta: unknown = JSON.parse(await fs.readFile(join(this.dir, name), 'utf8'));
        if (!isMeta(meta) || meta.jobId !== jobId || meta.stage !== stage) continue;
        if (unitId !== undefined && meta.unitId !== unitId) continue;
        const text = await fs.readFile(join(this.dir, `${jobId}.txt`), 'utf8').catch(() => '');
        const trace = await fs
          .readFile(join(this.dir, `${jobId}.trace.json`), 'utf8')
          .then((raw) => JSON.parse(raw) as ResearchTrace)
          .catch(() => null);
        entries.push({ meta, text, trace });
      } catch (err) {
        this.log(`inflight ${jobId} 읽기 실패: ${String(err)}`);
      }
    }
    return entries.sort(
      (a, b) => a.meta.attempt - b.meta.attempt || a.meta.startedAt.localeCompare(b.meta.startedAt),
    );
  }

  /** 기록을 지운다. 그 작업의 결과가 완료로 저장된 뒤, 또는 입력이 달라져 쓸 수 없을 때 부른다. */
  async remove(jobIds: readonly string[]): Promise<void> {
    for (const jobId of jobIds) {
      if (!JOB_ID.test(jobId)) continue;
      for (const suffix of ['.meta.json', '.txt', '.trace.json']) {
        await fs
          .rm(join(this.dir, `${jobId}${suffix}`), { force: true })
          .catch((err: unknown) => this.log(`inflight ${jobId} 지우기 실패: ${String(err)}`));
      }
    }
  }
}
