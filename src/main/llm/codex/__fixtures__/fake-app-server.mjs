// 테스트용 가짜 App Server (JSONL JSON-RPC). app-server-client.test.ts가 node로 띄운다.
// 요청: initialize → {ok:true}; echo → params; fail → error; slow → 응답 없음; crash → exit(3);
//       notify → 알림 test/ping 전송 후 {}; serverRequest → 클라이언트에 요청을 보내고 그 응답을 result로 돌려줌.
// 계정(C1.19, 0.157.1 실측 형태를 흉내): account/read, account/rateLimits/read(미로그인 -32600), account/login/start(chatgpt),
//       account/login/cancel, account/logout. 테스트 전용 test/completeLogin {loginId, success}는 브라우저 인증이 끝난 것처럼
//       account/login/completed(+성공 시 account/updated·account/rateLimits/updated)를 보낸다.
// 인자 --ignore-stdin-close: stdin이 닫혀도 종료하지 않는다 (SIGTERM 경로 확인용).
import { createInterface } from 'node:readline';

const ignoreClose = process.argv.includes('--ignore-stdin-close');
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const waiting = new Map();
let serverId = 900;
let loggedIn = false;
let pendingLogin = null;
let loginSeq = 0;
const RATE_LIMITS = {
  limitId: null,
  limitName: null,
  normalModelSlug: null,
  primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_790_500_000 },
  secondary: { usedPercent: 3, windowDurationMins: 10_080, resetsAt: null },
  credits: null,
  individualLimit: null,
  spendControlReached: null,
  planType: 'plus',
  rateLimitReachedType: null,
};
const completeLogin = (loginId, success, error) => {
  send({
    method: 'account/login/completed',
    params: { loginId, success, error, onboardingEntrypoint: null },
    emittedAtMs: Date.now(),
  });
};

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && msg.method === undefined) {
    const w = waiting.get(msg.id);
    if (w) {
      waiting.delete(msg.id);
      send({ id: w, result: { clientReplied: msg.error ?? msg.result } });
    }
    return;
  }
  if (msg.id === undefined) return;
  switch (msg.method) {
    case 'initialize':
      send({ id: msg.id, result: { ok: true, clientInfo: msg.params?.clientInfo ?? null } });
      break;
    case 'echo':
      send({ id: msg.id, result: msg.params });
      break;
    case 'fail':
      send({
        id: msg.id,
        error: { code: -32600, message: 'intentional failure', data: { why: 'test' } },
      });
      break;
    case 'slow':
      break;
    case 'crash':
      process.stderr.write('fake crash\n');
      process.exit(3);
      break;
    case 'notify':
      send({ method: 'test/ping', params: { n: 1 } });
      send({ id: msg.id, result: {} });
      break;
    case 'serverRequest': {
      const id = serverId++;
      waiting.set(id, msg.id);
      send({ id, method: 'item/tool/call', params: { fake: true } });
      break;
    }
    case 'account/read':
      send({
        id: msg.id,
        result: {
          account: loggedIn
            ? { type: 'chatgpt', email: 'user@example.com', planType: 'plus' }
            : null,
          requiresOpenaiAuth: !loggedIn,
          workspaceRouting: null,
        },
      });
      break;
    case 'account/rateLimits/read':
      if (!loggedIn) {
        send({
          id: msg.id,
          error: {
            code: -32600,
            message: 'codex account authentication required to read rate limits',
          },
        });
      } else {
        send({
          id: msg.id,
          result: {
            ordinaryUsageAllowed: true,
            rateLimits: RATE_LIMITS,
            rateLimitsByLimitId: null,
            rateLimitResetCredits: null,
            accountId: 'acct_fake',
            rateLimitUpsell: null,
          },
        });
      }
      break;
    case 'account/login/start': {
      if (pendingLogin) completeLogin(pendingLogin, false, 'Login server error: Login cancelled');
      loginSeq += 1;
      pendingLogin = `login-${loginSeq}`;
      send({
        id: msg.id,
        result: {
          type: 'chatgpt',
          loginId: pendingLogin,
          authUrl: `https://auth.example.test/oauth/authorize?state=${pendingLogin}`,
        },
      });
      break;
    }
    case 'account/login/cancel':
      if (msg.params?.loginId === pendingLogin) {
        const id = pendingLogin;
        pendingLogin = null;
        send({ id: msg.id, result: { status: 'canceled' } });
        completeLogin(id, false, 'Login server error: Login was not completed');
      } else if (/^login-\d+$/.test(String(msg.params?.loginId))) {
        send({ id: msg.id, result: { status: 'notFound' } });
      } else {
        send({
          id: msg.id,
          error: { code: -32600, message: `invalid login id: ${String(msg.params?.loginId)}` },
        });
      }
      break;
    case 'account/logout':
      loggedIn = false;
      send({ id: msg.id, result: {} });
      break;
    case 'test/completeLogin': {
      const { loginId, success } = msg.params ?? {};
      pendingLogin = null;
      send({ id: msg.id, result: {} });
      if (success) {
        loggedIn = true;
        completeLogin(loginId, true, null);
        send({ method: 'account/updated', params: { authMode: 'chatgpt', planType: 'plus' } });
        send({ method: 'account/rateLimits/updated', params: { rateLimits: RATE_LIMITS } });
      } else {
        completeLogin(loginId, false, 'fake: user denied');
      }
      break;
    }
    default:
      send({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
  }
});
rl.on('close', () => {
  if (!ignoreClose) process.exit(0);
});
if (ignoreClose) setInterval(() => undefined, 1000);
