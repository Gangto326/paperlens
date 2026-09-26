import { sha256Hex, stableStringify } from '../cache/hash';

/**
 * 로컬 GROBID 서비스 어댑터 (PLAN 4.2, COMMIT_PLAN C1.6).
 * - loopback 주소만 쓴다. 자동으로 Docker를 켜거나 이미지를 내려받지 않는다(0.3-7).
 * - 동시 요청 1개: 요청은 큐에 넣어 차례로 보낸다.
 * - 503(스레드 풀 소진)이면 retryDelayMs 뒤 최대 retryCount회 다시 보낸다.
 * - 이미지 태그와 요청 설정의 해시를 Pipeline.parserConfigHash에 기록한다.
 */
export interface GrobidConfig {
  baseUrl: string;
  /** 사용자에게 안내하는 기본 Docker 이미지. 실제로 어떤 이미지가 떠 있는지는 알 수 없어 /api/version으로 보완한다. */
  imageTag: string;
  /** 처리 요청(processFulltextDocument 등) 하나의 제한 시간. 수십 페이지 논문은 수십 초 걸린다. */
  timeoutMs: number;
  /** 헬스체크(/api/isalive, /api/version)의 제한 시간. 데몬이 꺼져 있으면 빨리 알아야 한다. */
  healthTimeoutMs: number;
  /** 503일 때 재시도 횟수 */
  retryCount: number;
  /** 503일 때 재시도 전 대기 (밀리초). 계획은 5~10초. */
  retryDelayMs: number;
}

export const DEFAULT_GROBID_CONFIG: GrobidConfig = {
  baseUrl: 'http://127.0.0.1:8070',
  imageTag: 'grobid/grobid:0.9.1-crf',
  timeoutMs: 120_000,
  healthTimeoutMs: 5_000,
  retryCount: 2,
  retryDelayMs: 7_000,
};

export const GROBID_RUN_COMMAND =
  'docker run --rm --init --ulimit core=0 -m 4g -p 127.0.0.1:8070:8070 grobid/grobid:0.9.1-crf';

export const GROBID_GUIDANCE = `GROBID 서비스에 연결할 수 없습니다. Docker Desktop을 실행한 뒤 터미널에서 다음 명령으로 GROBID를 띄우고 다시 시도하세요:\n${GROBID_RUN_COMMAND}`;

export type GrobidHealth =
  | { ok: true; version: string | null }
  | {
      ok: false;
      reason: 'unreachable' | 'timeout' | 'unhealthy';
      message: string;
      guidance: string;
    };

export class GrobidError extends Error {
  constructor(
    public readonly kind: 'unreachable' | 'timeout' | 'busy' | 'http',
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'GrobidError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class GrobidClient {
  readonly config: GrobidConfig;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    config: Partial<GrobidConfig> = {},
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {
    this.config = { ...DEFAULT_GROBID_CONFIG, ...config };
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(this.config.baseUrl)) {
      throw new Error(`GROBID baseUrl은 loopback만 허용: ${this.config.baseUrl}`);
    }
  }

  /** GET /api/isalive → "true". 성공하면 /api/version도 읽어 둔다(실패해도 ok). */
  async isAlive(): Promise<GrobidHealth> {
    let res: Response;
    try {
      res = await this.fetchRaw('/api/isalive', { method: 'GET' }, this.config.healthTimeoutMs);
    } catch (e) {
      const err = e instanceof GrobidError ? e : new GrobidError('unreachable', String(e));
      return {
        ok: false,
        reason: err.kind === 'timeout' ? 'timeout' : 'unreachable',
        message: err.message,
        guidance: GROBID_GUIDANCE,
      };
    }
    const body = (await res.text()).trim();
    if (!res.ok || body !== 'true') {
      return {
        ok: false,
        reason: 'unhealthy',
        message: `isalive 응답 ${res.status}: ${body.slice(0, 80)}`,
        guidance: GROBID_GUIDANCE,
      };
    }
    let version: string | null = null;
    try {
      const v = await this.fetchRaw('/api/version', { method: 'GET' }, this.config.healthTimeoutMs);
      if (v.ok) version = (await v.text()).trim() || null;
    } catch {
      version = null;
    }
    return { ok: true, version };
  }

  /**
   * 동시 1개·503 재시도가 적용된 요청. 응답 본문은 호출자가 읽는다.
   * 2xx가 아니면(503 재시도 소진 포함) GrobidError를 던진다.
   */
  request(path: string, init: RequestInit): Promise<Response> {
    const run = async (): Promise<Response> => {
      for (let attempt = 0; ; attempt++) {
        const res = await this.fetchRaw(path, init);
        if (res.status === 503 && attempt < this.config.retryCount) {
          await res.text().catch(() => undefined);
          await sleep(this.config.retryDelayMs);
          continue;
        }
        if (res.status === 503) {
          throw new GrobidError('busy', `GROBID가 바쁩니다(503, ${attempt + 1}회 시도)`, 503);
        }
        if (!res.ok) {
          const text = (await res.text().catch(() => '')).slice(0, 200);
          throw new GrobidError('http', `GROBID ${path} → ${res.status}: ${text}`, res.status);
        }
        return res;
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** 이미지 태그와 요청 설정을 합친 해시. C1.7에서 processFulltextDocument 매개변수를 넘긴다. */
  parserConfigHash(requestParams: Record<string, string | string[]> = {}): string {
    return sha256Hex(stableStringify({ imageTag: this.config.imageTag, requestParams })).slice(
      0,
      16,
    );
  }

  private async fetchRaw(
    path: string,
    init: RequestInit,
    timeoutMs: number = this.config.timeoutMs,
  ): Promise<Response> {
    const url = `${this.config.baseUrl}${path}`;
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal });
    } catch (e) {
      if (e instanceof Error && e.name === 'TimeoutError') {
        throw new GrobidError('timeout', `GROBID ${path} 응답 없음 (${timeoutMs}ms)`);
      }
      const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : '';
      throw new GrobidError('unreachable', `GROBID ${url} 연결 실패${cause ? `: ${cause}` : ''}`);
    }
  }
}
