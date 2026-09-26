import { describe, expectTypeOf, it } from 'vitest';
import type { ThreadStartParams } from './protocol/v2/ThreadStartParams';
import type { TurnStartParams } from './protocol/v2/TurnStartParams';
import type { ListMcpServerStatusParams } from './protocol/v2/ListMcpServerStatusParams';
import type { GetAccountParams } from './protocol/v2/GetAccountParams';
import type { GetAccountRateLimitsResponse } from './protocol/v2/GetAccountRateLimitsResponse';
import type { LoginAccountParams } from './protocol/v2/LoginAccountParams';
import generated from './protocol/GENERATED.json';
import pkg from '../../../../package.json';

// C1.17 확인 항목: 생성 바인딩이 계획(COMMIT_PLAN 0.4-B, C1.18~C1.20)에서 의존하는 필드를 제공하는지 타입 수준에서 고정한다.
describe('codex app-server protocol bindings', () => {
  it('thread/start accepts per-thread config overrides (mcp_servers 덮어쓰기 경로)', () => {
    expectTypeOf<ThreadStartParams>().toHaveProperty('config');
    expectTypeOf<ThreadStartParams>().toHaveProperty('sandbox');
    expectTypeOf<ThreadStartParams>().toHaveProperty('approvalPolicy');
    expectTypeOf<ThreadStartParams>().toHaveProperty('ephemeral');
    expectTypeOf<ThreadStartParams>().toHaveProperty('baseInstructions');
    expectTypeOf<ThreadStartParams>().toHaveProperty('developerInstructions');
    // dynamicTools는 --experimental 출력에만 있다. 안정 출력을 쓰므로 여기 없어야 한다.
    expectTypeOf<ThreadStartParams>().not.toHaveProperty('dynamicTools');
  });

  it('turn/start accepts outputSchema, sandboxPolicy, effort (구조화 출력·읽기 전용 샌드박스)', () => {
    expectTypeOf<TurnStartParams>().toHaveProperty('outputSchema');
    expectTypeOf<TurnStartParams>().toHaveProperty('sandboxPolicy');
    expectTypeOf<TurnStartParams>().toHaveProperty('effort');
  });

  it('mcpServerStatus/list, account/read, account/login/start, account/rateLimits/read 타입이 존재한다', () => {
    expectTypeOf<ListMcpServerStatusParams>().not.toBeNever();
    expectTypeOf<GetAccountParams>().not.toBeNever();
    expectTypeOf<LoginAccountParams>().toHaveProperty('type');
    expectTypeOf<GetAccountRateLimitsResponse>().toHaveProperty('rateLimits');
  });

  it('생성물의 codex 버전이 package.json 고정 버전과 같다', () => {
    if (generated.codexVersion !== pkg.dependencies['@openai/codex']) {
      throw new Error(
        `protocol/GENERATED.json ${generated.codexVersion} != package.json ${pkg.dependencies['@openai/codex']}; npm run codex:generate-ts`,
      );
    }
  });
});
