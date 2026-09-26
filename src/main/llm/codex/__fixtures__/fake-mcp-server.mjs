// 테스트용 최소 MCP stdio 서버: initialize / tools/list / ping 만 응답한다.
// codex-runtime.integration.test.ts가 thread/start.config.mcp_servers로 이 서버를 붙여 도구 노출 범위를 확인한다.
import { createInterface } from 'node:readline';

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '0.0.0' },
      },
    });
  } else if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'search',
            description: 'fake search',
            inputSchema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
          },
          {
            name: 'fetch',
            description: 'fake fetch',
            inputSchema: {
              type: 'object',
              properties: { candidateId: { type: 'string' } },
              required: ['candidateId'],
            },
          },
        ],
      },
    });
  } else if (msg.method === 'ping') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `unsupported: ${msg.method}` },
    });
  }
});
rl.on('close', () => process.exit(0));
