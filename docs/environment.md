# 개발 환경 확인 결과 (2026-09-26)

| 항목 | 확인값 |
|---|---|
| macOS | 26.2 (Darwin 25.2), Intel x86_64, i7-9750H, 16 GB |
| Node / npm | v25.9.0 / 11.12.1 (pnpm·yarn 없음) |
| Java | OpenJDK 17 (GROBID 로컬 Java 실행 대안) |
| Docker | Docker Desktop 29.2.1. 데몬은 수동으로 켜야 한다 |
| Codex | `codex` CLI는 PATH에 없음. 앱은 npm `@openai/codex`를 버전 고정해 사용한다 (ChatGPT.app 번들 바이너리는 사용하지 않음) |
| Electron / Vite | 44.4.5 / 7.3.6, electron-vite 5.0.0 |

## GROBID 실행 (Docker)

Docker Desktop을 먼저 실행한 뒤:

```sh
docker run --rm --init --ulimit core=0 -m 4g -p 127.0.0.1:8070:8070 grobid/grobid:0.9.1-crf
```

- CRF 이미지를 기본으로 쓴다. full(DeLFT) 이미지는 amd64 전용이며 메모리 부담이 크다.
- loopback에만 바인딩한다. 앱은 `http://127.0.0.1:8070/api/isalive`로 상태를 확인한다.
- 503이면 스레드 풀 소진이다. 5~10초 후 재시도한다.

## Codex 런타임 고정 방침

- `CODEX_HOME`을 앱 데이터 디렉터리 하위(`userData/codex-home`)로 두고, 그 안의 `config.toml`만 사용한다. 전역 `~/.codex`의 플러그인·설정은 읽지 않는다.
- 프로토콜 타입은 고정한 npm 버전의 `codex app-server generate-ts`로 생성해 커밋한다.
- 인증은 앱 안에서 `account/login/start {type: "chatgpt"}`로 1회 수행한다. `auth.json`은 커밋하지 않는다.
- 자식 프로세스 환경은 최소만 넘긴다(PATH·TMPDIR·LANG 등). `OPENAI_*`·`CODEX_*`는 넘기지 않고, HOME은 `codex-home/home`(빈 디렉터리)로 둔다 — HOME을 바꾸지 않으면 `~/.agents/skills`가 모델 프롬프트의 스킬 루트로 붙는다(0.157.1 실측).
- config.toml은 앱이 시작마다 생성하고 `app-server --strict-config`로 띄운다. `[features]`에서 shell·unified_exec·apps·multi_agent·goals·hooks·플러그인·브라우저·컴퓨터 사용 등을 끄고, 시작 후 `config/read`로 유효 설정을 대조해 다르면 시작 실패로 처리한다. 조사 도구(MCP)는 `thread/start.config.mcp_servers`로 해당 스레드에만 붙인다(스레드별 적용 실측 확인).

## 검사·실행

```sh
npm run dev      # 개발 실행
npm run check    # typecheck → lint → test
npm run build    # out/ 빌드
```
- 로그인은 앱 안의 "ChatGPT 로그인" 버튼으로 시작한다(`account/login/start {type:"chatgpt"}`). App Server가 `localhost:1455` 콜백 서버를 열고 앱이 인증 URL을 기본 브라우저로 연다. 인증 정보는 앱 전용 `CODEX_HOME`에만 저장되므로 전역 `codex login`과 별개다(0.157.1 실측).
- 한도는 `account/rateLimits/read`로만 조회하고 값이 없으면 "확인 불가"로 표시한다. 미로그인이면 오류(-32600)라 로그인 필요로 구분한다.
- 구조화 출력 스모크는 한도를 쓰므로 `PAPERLENS_LLM_SMOKE=1`로 앱을 띄웠을 때만 돈다(시작 시 로그인 상태면 바로, 아니면 로그인 완료 직후). 결과는 로그 `[codex] smoke …`와 `userData/llm/structured-smoke.json`(Usage 포함)에 남는다. 미로그인 턴은 401 재시도로 약 17초 뒤에야 실패하므로 턴 전에 계정 상태를 먼저 확인한다(0.157.1 실측). 같은 변수로 `npm test`를 돌리면 실제 app-server 미로그인 턴 테스트가 추가로 돈다(api.openai.com 접속).
