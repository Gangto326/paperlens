import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { GrobidClient, GrobidError } from './grobid-client';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server | null = null;

async function listen(handler: Handler): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return `http://127.0.0.1:${addr.port}`;
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
});

const fast = { timeoutMs: 500, healthTimeoutMs: 500, retryDelayMs: 1, retryCount: 2 };

describe('GrobidClient.isAlive', () => {
  it('isalive가 true이면 ok, version을 같이 준다', async () => {
    const baseUrl = await listen((req, res) => {
      if (req.url === '/api/isalive') res.end('true');
      else if (req.url === '/api/version') res.end('0.9.1');
      else res.writeHead(404).end();
    });
    const health = await new GrobidClient({ baseUrl, ...fast }).isAlive();
    expect(health).toEqual({ ok: true, version: '0.9.1' });
  });

  it('서비스가 없으면 unreachable + 앱 내 준비 안내', async () => {
    const baseUrl = await listen((_req, res) => res.end('true'));
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    const health = await new GrobidClient({ baseUrl, ...fast }).isAlive();
    expect(health.ok).toBe(false);
    if (!health.ok) {
      expect(health.reason).toBe('unreachable');
      expect(health.guidance).toContain('읽기 환경 준비');
    }
  });

  it('응답이 늦으면 timeout', async () => {
    const baseUrl = await listen(() => undefined);
    const health = await new GrobidClient({ baseUrl, ...fast, healthTimeoutMs: 50 }).isAlive();
    expect(health).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('isalive 본문이 true가 아니면 unhealthy', async () => {
    const baseUrl = await listen((_req, res) => res.end('false'));
    const health = await new GrobidClient({ baseUrl, ...fast }).isAlive();
    expect(health).toMatchObject({ ok: false, reason: 'unhealthy' });
  });
});

describe('GrobidClient.request', () => {
  it('503이면 재시도하고 성공하면 응답을 준다', async () => {
    let calls = 0;
    const baseUrl = await listen((_req, res) => {
      calls++;
      if (calls <= 2) res.writeHead(503).end('busy');
      else res.end('<TEI/>');
    });
    const res = await new GrobidClient({ baseUrl, ...fast }).request('/api/x', { method: 'POST' });
    expect(await res.text()).toBe('<TEI/>');
    expect(calls).toBe(3);
  });

  it('503이 재시도 횟수를 넘기면 busy 오류', async () => {
    let calls = 0;
    const baseUrl = await listen((_req, res) => {
      calls++;
      res.writeHead(503).end('busy');
    });
    const client = new GrobidClient({ baseUrl, ...fast });
    await expect(client.request('/api/x', { method: 'POST' })).rejects.toMatchObject({
      name: 'GrobidError',
      kind: 'busy',
      status: 503,
    });
    expect(calls).toBe(3);
  });

  it('다른 4xx/5xx는 http 오류', async () => {
    const baseUrl = await listen((_req, res) => res.writeHead(500).end('boom'));
    const client = new GrobidClient({ baseUrl, ...fast });
    const err = await client.request('/api/x', { method: 'POST' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrobidError);
    expect((err as GrobidError).kind).toBe('http');
    expect((err as GrobidError).message).toContain('boom');
  });

  it('동시에 보내도 서버에는 한 번에 하나만 도착한다', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const baseUrl = await listen((_req, res) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight--;
        res.end('ok');
      }, 20);
    });
    const client = new GrobidClient({ baseUrl, ...fast });
    const results = await Promise.all(
      [1, 2, 3].map(() => client.request('/api/x', { method: 'POST' }).then((r) => r.text())),
    );
    expect(results).toEqual(['ok', 'ok', 'ok']);
    expect(maxInFlight).toBe(1);
  });

  it('앞 요청이 실패해도 뒤 요청은 진행된다', async () => {
    let calls = 0;
    const baseUrl = await listen((_req, res) => {
      calls++;
      if (calls === 1) res.writeHead(500).end('x');
      else res.end('ok');
    });
    const client = new GrobidClient({ baseUrl, ...fast });
    const a = client.request('/api/x', { method: 'POST' }).catch(() => 'failed');
    const b = client.request('/api/x', { method: 'POST' }).then((r) => r.text());
    expect(await a).toBe('failed');
    expect(await b).toBe('ok');
  });
});

describe('GrobidClient 설정', () => {
  it('loopback이 아닌 주소는 거부한다', () => {
    expect(() => new GrobidClient({ baseUrl: 'http://10.0.0.5:8070' })).toThrow(/loopback/);
    expect(() => new GrobidClient({ baseUrl: 'http://localhost:8070' })).not.toThrow();
  });

  it('parserConfigHash는 이미지 태그·요청 매개변수에 따라 달라진다', () => {
    const a = new GrobidClient().parserConfigHash({ segmentSentences: '1' });
    const b = new GrobidClient().parserConfigHash({ segmentSentences: '1' });
    const c = new GrobidClient().parserConfigHash({ segmentSentences: '0' });
    const d = new GrobidClient({ imageTag: 'grobid/grobid:0.9.1-full' }).parserConfigHash({
      segmentSentences: '1',
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});
