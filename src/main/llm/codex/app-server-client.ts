import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * Codex App Server와의 stdio JSON-RPC 연결 (COMMIT_PLAN C1.18).
 * - 한 줄에 메시지 하나(JSONL). 서버 응답에는 `jsonrpc` 필드가 없다(0.157.1 실측). 요청에도 붙이지 않는다.
 * - 응답: `{id, result}` 또는 `{id, error:{code,message,data?}}`. 알림: `{method, params}`(id 없음).
 *   서버→클라이언트 요청(승인 등): `{id, method, params}` — 앱은 approval_policy=never라 오지 않아야 하며, 오면 거절한다.
 * - 프로세스 종료를 감지한다. `close()`로 시작한 종료는 expected=true, 그 밖의 종료는 크래시(expected=false)로 본다.
 */
export type JsonRpcId = number | string;

export class AppServerError extends Error {
  constructor(
    public readonly kind: 'rpc' | 'timeout' | 'exited' | 'transport',
    message: string,
    public readonly code?: number,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'AppServerError';
  }
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** close()로 시작한 종료면 true. false면 크래시. */
  expected: boolean;
  /** 마지막 stderr 줄들 (진단용) */
  stderrTail: string[];
}

export interface AppServerClientOptions {
  /** 요청 기본 제한 시간 */
  requestTimeoutMs?: number;
  /** 보관하는 stderr 줄 수 */
  stderrTailLines?: number;
  log?: (line: string) => void;
}

export type NotificationHandler = (params: unknown, method: string) => void;
export type ServerRequestHandler = (request: {
  id: JsonRpcId;
  method: string;
  params: unknown;
}) => Promise<unknown>;

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

type Message = {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class AppServerClient {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private readonly exitHandlers = new Set<(info: ExitInfo) => void>();
  private serverRequestHandler: ServerRequestHandler | null = null;
  private readonly stderrTail: string[] = [];
  private stateValue: 'running' | 'closing' | 'exited' = 'running';
  private exitInfoValue: ExitInfo | null = null;
  private readonly exited: Promise<ExitInfo>;
  private resolveExited!: (info: ExitInfo) => void;
  private readonly requestTimeoutMs: number;
  private readonly stderrTailLines: number;

  constructor(
    private readonly child: ChildProcess,
    private readonly options: AppServerClientOptions = {},
  ) {
    if (!child.stdout || !child.stdin) {
      throw new AppServerError('transport', 'App Server 자식 프로세스에 stdio 파이프가 없습니다');
    }
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.stderrTailLines = options.stderrTailLines ?? 50;
    this.exited = new Promise<ExitInfo>((resolve) => {
      this.resolveExited = resolve;
    });
    createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line));
    if (child.stderr) {
      createInterface({ input: child.stderr }).on('line', (line) => this.pushStderr(line));
    }
    child.stdin.on('error', (err: Error) => this.log(`stdin 오류: ${err.message}`));
    child.once('exit', (code, signal) => this.finish(code, signal));
    child.once('error', (err: Error) => {
      // spawn 실패 등. 'exit'가 뒤따르지 않을 수 있어 여기서 종료 처리한다.
      this.log(`프로세스 오류: ${err.message}`);
      this.finish(null, null);
    });
  }

  get state(): 'running' | 'closing' | 'exited' {
    return this.stateValue;
  }

  get exitInfo(): ExitInfo | null {
    return this.exitInfoValue;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  recentStderr(): string[] {
    return [...this.stderrTail];
  }

  /** 응답을 기다리는 요청. 제한 시간·프로세스 종료·RPC 오류는 AppServerError로 거절된다. */
  request<T = unknown>(
    method: string,
    params: unknown = {},
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.stateValue === 'exited') {
      return Promise.reject(
        new AppServerError('exited', `App Server가 종료되어 ${method} 요청을 보낼 수 없습니다`),
      );
    }
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(
                new AppServerError(
                  'timeout',
                  `${method} 응답이 ${timeoutMs}ms 안에 오지 않았습니다`,
                ),
              );
            }, timeoutMs)
          : null;
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.write({ id, method, params });
    });
  }

  /** 응답 없는 알림 (`initialized` 등) */
  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  /** 알림 구독. method가 '*'이면 전부. 반환값은 구독 해제 함수. */
  onNotification(method: string, handler: NotificationHandler): () => void {
    let set = this.notificationHandlers.get(method);
    if (!set) {
      set = new Set();
      this.notificationHandlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  /** 서버→클라이언트 요청 처리기. 없거나 throw하면 오류 응답(-32601)을 보낸다. */
  onServerRequest(handler: ServerRequestHandler | null): void {
    this.serverRequestHandler = handler;
  }

  onExit(handler: (info: ExitInfo) => void): () => void {
    this.exitHandlers.add(handler);
    return () => {
      this.exitHandlers.delete(handler);
    };
  }

  /** stdin을 닫아 정상 종료를 유도하고, 안 끝나면 SIGTERM → SIGKILL. */
  async close(options: { graceMs?: number; termMs?: number } = {}): Promise<ExitInfo> {
    if (this.stateValue === 'exited' && this.exitInfoValue) return this.exitInfoValue;
    this.stateValue = 'closing';
    this.child.stdin?.end();
    const graceMs = options.graceMs ?? 3_000;
    const termMs = options.termMs ?? 2_000;
    let info = await Promise.race([this.exited, sleep(graceMs).then(() => null)]);
    if (!info) {
      this.log(`stdin을 닫은 뒤 ${graceMs}ms 안에 끝나지 않아 SIGTERM을 보냅니다`);
      this.child.kill('SIGTERM');
      info = await Promise.race([this.exited, sleep(termMs).then(() => null)]);
    }
    if (!info) {
      this.log(`SIGTERM 뒤 ${termMs}ms 안에 끝나지 않아 SIGKILL을 보냅니다`);
      this.child.kill('SIGKILL');
      info = await this.exited;
    }
    return info;
  }

  private write(message: object): void {
    const stdin = this.child.stdin;
    if (!stdin || this.stateValue === 'exited') return;
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.log(`JSON이 아닌 stdout 줄: ${line.slice(0, 200)}`);
      return;
    }
    if (!isRecord(message)) return;
    const msg = message as Message;
    if (msg.id !== undefined && typeof msg.method === 'string') {
      void this.handleServerRequest(msg.id, msg.method, msg.params);
      return;
    }
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) {
        this.log(`대기 중이 아닌 응답 id=${String(msg.id)}`);
        return;
      }
      this.pending.delete(msg.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.error !== undefined) {
        const err = isRecord(msg.error) ? msg.error : {};
        pending.reject(
          new AppServerError(
            'rpc',
            `${pending.method}: ${typeof err['message'] === 'string' ? err['message'] : JSON.stringify(msg.error)}`,
            typeof err['code'] === 'number' ? err['code'] : undefined,
            err['data'],
          ),
        );
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === 'string') {
      for (const key of [msg.method, '*']) {
        const set = this.notificationHandlers.get(key);
        if (!set) continue;
        for (const handler of set) {
          try {
            handler(msg.params, msg.method);
          } catch (err) {
            this.log(
              `알림 처리기 오류(${msg.method}): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }
  }

  private async handleServerRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    if (this.serverRequestHandler) {
      try {
        const result = await this.serverRequestHandler({ id, method, params });
        this.write({ id, result: result ?? null });
        return;
      } catch (err) {
        this.write({
          id,
          error: { code: -32601, message: err instanceof Error ? err.message : String(err) },
        });
        return;
      }
    }
    this.log(`서버 요청 ${method}를 거절합니다 (처리기 없음)`);
    this.write({
      id,
      error: { code: -32601, message: `PaperLens는 ${method} 요청을 처리하지 않습니다` },
    });
  }

  private pushStderr(line: string): void {
    this.stderrTail.push(line);
    if (this.stderrTail.length > this.stderrTailLines) this.stderrTail.shift();
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.stateValue === 'exited') return;
    const info: ExitInfo = {
      code,
      signal,
      expected: this.stateValue === 'closing',
      stderrTail: this.recentStderr(),
    };
    this.stateValue = 'exited';
    this.exitInfoValue = info;
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(
        new AppServerError(
          'exited',
          `${pending.method} 응답 전에 App Server가 종료됐습니다 (code=${String(code)} signal=${String(signal)})`,
        ),
      );
      this.pending.delete(id);
    }
    this.resolveExited(info);
    for (const handler of this.exitHandlers) handler(info);
  }

  private log(line: string): void {
    this.options.log?.(line);
  }
}
