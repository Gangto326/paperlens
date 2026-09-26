// 테스트용 가짜 App Server (JSONL JSON-RPC). app-server-client.test.ts가 node로 띄운다.
// 요청: initialize → {ok:true}; echo → params; fail → error; slow → 응답 없음; crash → exit(3);
//       notify → 알림 test/ping 전송 후 {}; serverRequest → 클라이언트에 요청을 보내고 그 응답을 result로 돌려줌.
// 인자 --ignore-stdin-close: stdin이 닫혀도 종료하지 않는다 (SIGTERM 경로 확인용).
import { createInterface } from 'node:readline';

const ignoreClose = process.argv.includes('--ignore-stdin-close');
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const waiting = new Map();
let serverId = 900;

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
    default:
      send({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
  }
});
rl.on('close', () => {
  if (!ignoreClose) process.exit(0);
});
if (ignoreClose) setInterval(() => undefined, 1000);
