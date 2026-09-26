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

## 검사·실행

```sh
npm run dev      # 개발 실행
npm run check    # typecheck → lint → test
npm run build    # out/ 빌드
```
