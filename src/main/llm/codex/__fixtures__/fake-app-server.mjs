// 테스트용 가짜 App Server (JSONL JSON-RPC). app-server-client.test.ts가 node로 띄운다.
// 요청: initialize → {ok:true}; echo → params; fail → error; slow → 응답 없음; crash → exit(3);
//       notify → 알림 test/ping 전송 후 {}; serverRequest → 클라이언트에 요청을 보내고 그 응답을 result로 돌려줌.
// 계정(C1.19, 0.157.1 실측 형태를 흉내): account/read, account/rateLimits/read(미로그인 -32600), account/login/start(chatgpt),
//       account/login/cancel, account/logout. 테스트 전용 test/completeLogin {loginId, success}는 브라우저 인증이 끝난 것처럼
//       account/login/completed(+성공 시 account/updated·account/rateLimits/updated)를 보낸다.
// 턴(C1.20, 0.157.1 실측 순서를 흉내): thread/start, turn/start(응답 뒤 turn/started → item/completed → thread/tokenUsage/updated →
//       turn/completed), turn/interrupt. 입력 글의 지시어로 동작을 고른다: `FAKE:reply <글>` 그 글로 응답, `FAKE:silent` agent message 없음,
//       `FAKE:hang` turn/interrupt가 올 때까지 대기, `FAKE:limit` usageLimitExceeded 실패, `FAKE:rpcfail` turn/start 오류, `FAKE:crash` 턴 중 종료.
//       지시어가 없으면 미로그인일 때 401 실패, 로그인 상태면 스모크 기대값으로 응답한다.
// 진행·중단(C2.1, 0.157.1 실측을 흉내): `FAKE:stream <글>`은 reasoning 항목 → agentMessage item/started →
//       4글자씩 15ms 간격 item/agentMessage/delta → item/completed → 사용량 → turn/completed. 도중에 turn/interrupt가 오면
//       delta를 멈추고 item/completed·사용량 없이 turn/completed status:'interrupted'만 보낸다.
//       `FAKE:deaf`는 turn/interrupt에 응답만 하고 턴을 끝내지 않는다(중단 확인 실패 경로).
// 인자 --default-reply=<글>: 지시어 없는 턴의 응답 글을 바꾼다.
// 인자 --ignore-stdin-close: stdin이 닫혀도 종료하지 않는다 (SIGTERM 경로 확인용).
import { createInterface } from 'node:readline';

const ignoreClose = process.argv.includes('--ignore-stdin-close');
const DEFAULT_REPLY_FLAG = '--default-reply=';
const defaultReply =
  process.argv.find((a) => a.startsWith(DEFAULT_REPLY_FLAG))?.slice(DEFAULT_REPLY_FLAG.length) ??
  '{"answer":"paperlens-ok","n":3}';
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
let threadSeq = 0;
let turnSeq = 0;
const hanging = new Map();
const streaming = new Map();
const TOKEN_USAGE = {
  totalTokens: 1244,
  inputTokens: 1200,
  cachedInputTokens: 200,
  cacheWriteInputTokens: 0,
  outputTokens: 44,
  reasoningOutputTokens: 10,
};
const turnOf = (id, status, error = null) => ({
  id,
  items: [],
  itemsView: 'notLoaded',
  status,
  error,
  startedAt: 1_790_497_369,
  completedAt: status === 'inProgress' ? null : 1_790_497_370,
  durationMs: status === 'inProgress' ? null : 1000,
});
const agentMessage = (threadId, turnId, id, text, phase) =>
  send({
    method: 'item/completed',
    params: {
      item: {
        type: 'agentMessage',
        id,
        text,
        phase,
        memoryCitation: null,
        delivery: null,
        questions: null,
      },
      threadId,
      turnId,
      completedAtMs: Date.now(),
    },
    emittedAtMs: Date.now(),
  });
const itemStarted = (threadId, turnId, item) =>
  send({ method: 'item/started', params: { item, threadId, turnId, startedAtMs: Date.now() } });
const tokenUsage = (threadId, turnId) =>
  send({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId,
      turnId,
      tokenUsage: { total: TOKEN_USAGE, last: TOKEN_USAGE, modelContextWindow: 200_000 },
    },
  });
const completeTurn = (threadId, turnId, status, error = null) =>
  send({
    method: 'turn/completed',
    params: { threadId, turn: turnOf(turnId, status, error) },
    emittedAtMs: Date.now(),
  });
const turnError = (message, codexErrorInfo) => ({
  message,
  codexErrorInfo,
  additionalDetails: null,
  misalignment: null,
});
const runTurn = (threadId, turnId, text) => {
  send({ method: 'turn/started', params: { threadId, turn: turnOf(turnId, 'inProgress') } });
  const directive = /^FAKE:(\w+)\s*([\s\S]*)$/.exec(text);
  const kind = directive ? directive[1] : loggedIn ? 'default' : 'unauthorized';
  switch (kind) {
    case 'hang':
      hanging.set(turnId, threadId);
      return;
    case 'deaf':
      return;
    case 'stream': {
      const reply = directive[2];
      const reasoning = { type: 'reasoning', id: `${turnId}-r`, summary: [], content: [] };
      itemStarted(threadId, turnId, reasoning);
      send({
        method: 'item/completed',
        params: { item: reasoning, threadId, turnId, completedAtMs: Date.now() },
      });
      const itemId = `${turnId}-f`;
      itemStarted(threadId, turnId, {
        type: 'agentMessage',
        id: itemId,
        text: '',
        phase: 'final_answer',
        memoryCitation: null,
        delivery: null,
        questions: null,
      });
      let at = 0;
      const timer = setInterval(() => {
        if (at < reply.length) {
          const delta = reply.slice(at, at + 4);
          at += 4;
          send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId, delta } });
          return;
        }
        clearInterval(timer);
        streaming.delete(turnId);
        agentMessage(threadId, turnId, itemId, reply, 'final_answer');
        tokenUsage(threadId, turnId);
        completeTurn(threadId, turnId, 'completed');
      }, 15);
      streaming.set(turnId, { threadId, timer });
      return;
    }
    case 'crash':
      process.stderr.write('fake crash during turn\n');
      process.exit(3);
      return;
    case 'limit':
      completeTurn(
        threadId,
        turnId,
        'failed',
        turnError("You've hit your usage limit.", 'usageLimitExceeded'),
      );
      return;
    case 'unauthorized':
      completeTurn(
        threadId,
        turnId,
        'failed',
        turnError(
          'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses',
          'other',
        ),
      );
      return;
    default:
  }
  // 다른 스레드의 알림이 섞여 와도 이 턴의 결과에 들어가면 안 된다.
  agentMessage('thread-other', 'turn-other', 'item-noise', '{"answer":"noise","n":0}', null);
  if (kind !== 'silent') {
    agentMessage(threadId, turnId, `${turnId}-c`, 'Working on it.', 'commentary');
    const reply = kind === 'reply' ? directive[2] : defaultReply;
    agentMessage(threadId, turnId, `${turnId}-f`, reply, 'final_answer');
  }
  tokenUsage(threadId, turnId);
  completeTurn(threadId, turnId, 'completed');
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
    case 'thread/start': {
      threadSeq += 1;
      const id = `thread-${threadSeq}`;
      send({
        id: msg.id,
        result: {
          thread: { id, ephemeral: true },
          model: 'fake-model',
          sandbox: { type: 'readOnly', networkAccess: false },
          approvalPolicy: 'never',
        },
      });
      break;
    }
    case 'turn/start': {
      const text = String(msg.params?.input?.[0]?.text ?? '');
      if (text.startsWith('FAKE:rpcfail')) {
        send({ id: msg.id, error: { code: -32600, message: 'thread not found' } });
        break;
      }
      turnSeq += 1;
      const turnId = `turn-${turnSeq}`;
      send({ id: msg.id, result: { turn: turnOf(turnId, 'inProgress') } });
      runTurn(String(msg.params?.threadId), turnId, text);
      break;
    }
    case 'turn/interrupt': {
      const turnId = msg.params?.turnId;
      const threadId = hanging.get(turnId);
      send({ id: msg.id, result: {} });
      if (threadId !== undefined) {
        hanging.delete(turnId);
        completeTurn(threadId, turnId, 'interrupted');
      }
      const stream = streaming.get(turnId);
      if (stream !== undefined) {
        clearInterval(stream.timer);
        streaming.delete(turnId);
        completeTurn(stream.threadId, turnId, 'interrupted');
      }
      break;
    }
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
