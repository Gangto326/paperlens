# PaperLens 커밋 단위 구현 계획

작성일: 2026-09-26
기준 문서: `PLAN.md` (2026-09-25 검토본)
상태: 계획 검토 결과와 커밋 순서 제안. 앱 코드는 아직 작성하지 않았다.

## 0. PLAN.md 검토 결과

### 0.1 이 Mac에서 확인한 사실 (PLAN.md 1.2의 미확정 항목 해소)

| 항목 | 확인값 | 계획에 미치는 영향 |
|---|---|---|
| macOS | 26.2 (Darwin 25.2), Intel x86_64 | 현행 Electron·Node·PDF.js 모두 지원 범위. 구형 OS 리스크 없음 |
| CPU / RAM | i7-9750H, 16 GB | GROBID full(DeLFT) 이미지는 메모리 부담이 큼. CRF 이미지를 기본으로 시작 |
| Node / npm | v25.9.0 / 11.12.1 | pnpm·yarn 없음. npm 사용 |
| Java | OpenJDK 17 | GROBID 0.8.x의 로컬 Java 실행 경로가 열려 있음 (Docker 대안) |
| Docker | 29.2.1 설치됨, **데몬은 꺼져 있음** | GROBID Docker 경로 사용 가능. 앱이 "Docker 실행 필요" 안내를 해야 함 |
| Codex 런타임 | `codex` CLI는 PATH에 없음. ChatGPT.app 번들 `codex-cli 0.155.0-alpha.9.2`, npm `@openai/codex` 0.157.1 | 번들 바이너리는 앱 업데이트로 바뀌므로 **npm 패키지를 버전 고정해 앱 전용으로 설치** |
| `codex app-server` | 존재. `generate-ts`, `generate-json-schema` 서브커맨드 제공 | PLAN 4.2의 "프로토콜 스키마 생성·고정"이 실제로 가능 |
| `~/.codex/config.toml` | 모델 `gpt-6-astra`, browser·computer-use 등 전역 플러그인 다수 활성 | PLAN 4.3의 우려가 실제 상황. **앱 전용 `CODEX_HOME`으로 격리** 필요 |
| 참조 URL | learn.chatgpt.com, grobid.readthedocs.io 주요 문서 7건 모두 200 응답 | 근거 링크 유효 |

`~/.codex/auth.json`은 열지 않았다. 인증 정보는 계획 검토 대상이 아니다.

### 0.2 계획의 일관성 검토

수치·구조 계산은 서로 맞는다.

- 11.1 계산식: `2T + n×4,400` → 일반 50,400 / 긴 논문 210,000 ✓. 턴 수 `n + 3 + (0|5) + 2r` → 9~21 / 33~45 ✓.
- 13절 마일스톤 합계 3~5 + 2~4 + 2~4 + 4~7 + 3~5 = 14~25일 ✓.
- 좌표계(GROBID 1-based·top-left ↔ 앱 0-based `pageIndex` + `coordinateSpace` enum), 예산 범위 표, 상태 enum, 불변 조건 사이에 모순 없음.
- "계획 승인 전 앱 코드 작성 금지"(1.1)를 이 문서도 준수한다.

### 0.3 구현 전에 확정해야 할 보완점 (차단 사항 아님)

아래는 PLAN.md의 방향을 바꾸지 않는 범위에서, 코드로 옮길 때 모호해지는 지점이다. 각 항목의 "제안"을 이 커밋 계획의 기본 가정으로 삼았다.

**검증 결과 (2026-09-26, 0.4절에 근거)**: 8개 중 7개는 원안 그대로 승인 가능하고, 6번(PDF.js 실행 위치)은 수정 후 승인한다. 2번은 원안을 유지하되 도구 노출 방식의 세부를 0.4에서 보완했다.

| # | 보완점 | 판정 | 근거 요약 |
|---|---|---|---|
| 1 | Sentence / SentenceResult 분리 | **승인** | 내부 설계. 외부 의존 없음. PLAN 8.2 불변 조건을 파일 단위로 강제 |
| 2 | 예산 장부 단일 소유(MCP 얇은 프록시) | **승인** | MCP 서버는 App Server가 `config.toml`(`[mcp_servers.<name>]`, stdio)로 띄움을 확인. 장부를 메인이 소유하는 구조가 필요. 단계별 도구 노출은 0.4-B 참조 |
| 3 | fetch는 candidateId 입력 | **승인** | 내부 설계. PLAN 7절 규칙을 구조로 강제 |
| 4 | needsResearch 판별 유니온 + 재시도 턴 스키마 제한 | **승인** | `turn/start.outputSchema`가 턴 단위로 적용됨을 문서·스키마에서 확인. 턴마다 다른 스키마 전달 가능 |
| 5 | 앱 전용 CODEX_HOME | **승인** | `CODEX_HOME`이 config·auth 저장 위치를 결정함을 공식 문서에서 확인. 로그인은 `account/login/start {type: "chatgpt"}` |
| 6 | PDF.js를 renderer 워커에서 실행 | **수정 승인** | PDF.js는 자체 `PDFWorker`에서 파싱·텍스트 추출을 수행. 중첩 Web Worker 불필요. 핵심 조건은 "renderer의 단일 `pdfjs-dist` 버전으로 추출·표시 모두 수행"이며 메인 프로세스에 PDF.js를 두지 않는 점은 유지 |
| 7 | Docker 미실행 안내 | **승인** | GROBID 공식: fulltext에 4GB 권장, CRF 이미지 `grobid/grobid:0.9.1-crf`는 amd64 지원. 16GB Mac에서 CRF 기본이 타당 |
| 8 | Vite + electron-vite / Vitest / Playwright / ESLint | **승인** | npm 최신: electron-vite 5.0.0, vitest 5.0.2, @playwright/test 1.63.0, pdfjs-dist 6.3.289, electron 44.4.5. 모두 최근 갱신 |

PLAN.md 14.1의 4개 결정(텍스트 PDF 우선, GROBID 별도 실행, 자체 MCP 검색+영속 예산, 초기 예산·품질 기준은 제안값)도 이번 검증에서 바꿀 근거가 나오지 않았다. **4개 모두 원안 승인을 권한다.** 2번은 Java 17이 있어 Docker 없는 경로도 열려 있으나, GROBID 문서가 Docker를 권장하므로 초기 선택은 유지한다.

1. **Sentence 스키마의 이중 소속 (8.2 vs 8.1)**
   8.2의 `Sentence`에 `ko`·`note`·`refs`·`status`가 있지만 8.1 파일 배치에서는 번역 결과가 `generations/<gid>/chunks/*.json`에 있다.
   제안: 추출 불변 객체 `Sentence`(document.json)와 세대별 `SentenceResult`(chunks)를 스키마에서 분리하고, UI가 읽는 합성 뷰는 메모리에서만 만든다. 불변 조건 "문장 en·ID·위치는 LLM 출력으로 덮어쓰지 않는다"를 파일 수준에서 강제할 수 있다.

2. **예산 장부의 단일 소유자 (3.3 항목 3·4)**
   Codex가 MCP 서버를 자식 프로세스로 띄우면 장부(`budget.json`)에 쓰는 프로세스가 Electron 메인과 MCP 서버 둘이 된다.
   제안: MCP 서버는 **얇은 프록시**로 만들고, 작업 토큰을 들고 Electron 메인의 로컬 소켓(unix socket)으로 검색·열람을 위임한다. 장부·검색·열람은 메인 프로세스가 단독 소유한다. `paperId`·예산값은 도구 인자에 아예 없다.

3. **fetch 도구의 입력 (7절)**
   "모델이 기억으로 쓴 URL을 읽기 도구에 넘기지 않는다"를 규칙이 아닌 구조로 강제하려면 `fetch`가 URL이 아니라 `search`가 발급한 `candidateId`(또는 bibliography 항목 ID)를 받게 한다.

4. **needsResearch 반복 상한 (6.2)**
   청크 턴이 `needsResearch`를 무한히 돌려주지 않도록, 출력 스키마를 `kind: "results" | "needsResearch"` 판별 유니온으로 정의하고, 보충 조사 1회 후 재시도 턴에는 `results`만 허용하는 스키마를 전달한다. 프롬프트 지시(6.6 규칙 6)가 아니라 앱이 강제한다.

5. **Codex 실행 격리 (4.3)**
   전역 `~/.codex/config.toml`에 browser·computer-use 등이 켜져 있다.
   제안: 앱 데이터 디렉터리 하위에 전용 `CODEX_HOME`을 두고 그 안의 `config.toml`만 사용한다. 로그인은 앱 안에서 1회 수행한다(같은 구독을 쓰므로 비용 경로는 동일). 유효 도구 목록을 M1에서 실제로 덤프해 확인한다.

6. **PDF.js 실행 위치 (5.1 단계 2)**
   추출용 텍스트 항목과 화면 텍스트 레이어가 같은 `pdfjs-dist` 버전·같은 API에서 나와야 매핑이 성립한다.
   제안(검증 후 수정): 추출은 renderer에서 같은 `pdfjs-dist` 인스턴스의 `getTextContent()`로 수행한다. 파싱은 PDF.js 자체 `PDFWorker`가 담당하므로 별도 Web Worker는 두지 않는다. 결과는 IPC로 메인에 넘겨 저장하고, 메인에는 PDF.js를 두지 않는다.

7. **Docker 데몬 미실행 상태**
   현재 데몬이 꺼져 있다. 앱은 GROBID 헬스체크 실패 시 "Docker Desktop을 실행하고 다시 시도"를 안내하고, 자동으로 Docker를 켜거나 이미지를 내려받지 않는다.

8. **미지정 도구 선택**
   PLAN.md는 번들러·테스트 러너·린터를 정하지 않았다. 제안: Vite + electron-vite, Vitest(단위), Playwright for Electron(M5 E2E 최소), ESLint + Prettier, TypeScript strict.

이 8개 항목을 반영하면 PLAN.md는 구현에 착수할 수 있는 상태다.

### 0.4 외부 문서·프로토콜 스키마로 확인한 사실

공식 문서(learn.chatgpt.com, grobid.readthedocs.io, mozilla.github.io/pdf.js)와 이 Mac의 번들 Codex(`codex-cli 0.155.0-alpha.9.2`)가 생성한 `app-server generate-json-schema` 출력을 기준으로 한다. 앱에서 실행해 검증한 것은 아니다.

**A. Codex App Server 프로토콜**

| 항목 | 확인값 | 반영 커밋 |
|---|---|---|
| 구조화 출력 | `turn/start` 파라미터에 `outputSchema` 존재. 해당 턴에만 적용 | C2.1, C2.5, C4.10 |
| 로그인 | `account/login/start`의 `type`: `chatgpt`, `chatgptDeviceCode`, `apiKey`. `account/login/completed` 알림, `account/logout` | C1.19 |
| 한도 조회 | `account/rateLimits/read` → `RateLimitSnapshot{primary, secondary: RateLimitWindow{usedPercent, resetsAt?, windowDurationMins?}, planType?}`. `account/rateLimits/updated` 알림 | C1.19, C3.5 |
| 사용량 | `account/usage/read`, `thread/tokenUsage/updated` 알림 | C2.8 |
| 스레드 시작 | `thread/start` 파라미터: `approvalPolicy`, `sandbox`(`read-only`/`workspace-write`/`danger-full-access`), `config`(자유 형식 객체, 스레드별 설정 덮어쓰기), `ephemeral`, `baseInstructions`, `developerInstructions`, `model` | C1.18, C4.7 |
| 턴 시작 | `turn/start` 파라미터: `sandboxPolicy`(readOnly는 `networkAccess` 기본 false), `approvalPolicy`, `effort`, `outputSchema`, `disabledPluginIds` | C1.18 |
| 중단 | `turn/interrupt` | C2.1 |
| MCP | `config.toml`의 `[mcp_servers.<name>]`(`command`, `args`, `env`)로 정의하고 App Server가 stdio 자식으로 실행. `config/mcpServer/reload`로 재적재. `mcpServerStatus/list`로 상태 확인 | C4.6, C4.7 |
| dynamic tools | 웹 문서의 `thread/start`에는 `dynamicTools`가 있으나 번들 0.155 스키마에는 없음. `item/tool/call` 요청 정의는 존재 | 대안으로만 기록 |
| 설정 키 | `web_search`: `cached`/`indexed`/`live`/`disabled`. `approval_policy`: `on-request`/`never`. `sandbox_mode`: `read-only` 등. `[features]`: `shell_tool`, `unified_exec`, `apps`, `multi_agent`, `goals`, `hooks`, `web_search` 등 | C1.18 |
| CODEX_HOME | 인증 문서: "credentials in auth.json under CODEX_HOME (defaults to ~/.codex)". 설정 문서에도 동일. `-p <profile>`로 `$CODEX_HOME/<name>.config.toml` 레이어링도 가능 | C1.18 |

**B. 단계별 도구 노출 방법 (보완점 2·C4.7의 세부)**

MCP 서버는 설정 파일 수준에서 정의되므로 "조사 턴에만 도구를 붙이고 번역 턴에서 뗀다"를 턴 단위로 직접 할 수는 없다. 우선순위는 다음과 같다.

1. `thread/start.config`에 `mcp_servers`를 넣어 **조사용 스레드**와 **도구 없는 스레드**를 분리한다. 스키마상 `config`는 자유 형식이므로 `mcp_servers` 덮어쓰기가 실제로 적용되는지 C1.18에서 `mcpServerStatus/list`로 확인한다.
2. 적용되지 않으면 CODEX_HOME 하나에 프로필 2개(`research.config.toml`, `plain.config.toml`)를 두고 App Server 프로세스를 2개 띄운다. 인증은 공유된다.
3. 위 둘 다 실패할 때만 `dynamicTools`(npm 0.157.1에서 존재 여부 확인)를 검토한다. PLAN 4.2의 "MCP 우선"과 일치한다.

어느 경우든 번역·통합 턴에서 모델이 보는 도구 목록을 턴 시작 전에 검사하고, `search`·`fetch`가 보이면 턴을 시작하지 않는다.

**C. GROBID**

| 항목 | 확인값 |
|---|---|
| 이미지 | `grobid/grobid:{version}-full`(amd64 전용, DeLFT) / `grobid/grobid:{version}-crf`(0.8.1부터 x86_64·arm64). 최신 문서 예시는 0.9.1 |
| 메모리 | `processFulltextDocument`에 4GB 권장 |
| 파라미터 | `segmentSentences=1`, `teiCoordinates`는 `persName`, `figure`, `ref`, `biblStruct`, `formula`, `s`만 허용(반복 지정). `consolidateHeader=0`, `consolidateCitations=0`(기본) |
| 과부하 | 503이면 5~10초 후 재시도 권고 |

C1.7의 `teiCoordinates` 목록에서 `p`, `head`, `table`, `note`를 제거했다. 표는 GROBID에서 `figure` 유형으로 표현된다.

**D. PDF.js**

`PDFWorker`가 파싱을 별도 스레드에서 수행하고, `getTextContent()`는 `TextItem{str, transform, width, height, fontName, dir, hasEOL}`을 반환한다. 추출 자체를 위해 renderer가 Web Worker를 추가로 둘 필요는 없다. 보완점 6을 이에 맞게 수정했다.

**E. 도구 버전 (npm, 2026-09-26)**

electron 44.4.5, electron-vite 5.0.0, pdfjs-dist 6.3.289, vitest 5.0.2, @playwright/test 1.63.0, ajv 8.20.0, fast-xml-parser 5.11.1, @mozilla/readability 0.6.0, @openai/codex 0.157.1.

## 1. 커밋 규칙

- 브랜치: `main`에 직접 순차 커밋. 개인 프로젝트이며 배포가 없으므로 PR 없이 진행하되, 각 커밋은 단독으로 `npm test`가 통과해야 한다.
- 메시지: `type(scope): 요약` (예: `feat(mapping): GROBID 문장 사각형과 PDF.js 항목 후보 연결`). type은 `chore`, `feat`, `fix`, `test`, `docs`, `refactor`.
- 한 커밋은 하나의 검증 가능한 단위. "동작 확인 방법" 없이 커밋하지 않는다.
- 스냅샷 데이터(샘플 PDF, TEI, 정답 매핑)는 `fixtures/`에 두고, 저작권상 재배포가 불명확한 PDF는 커밋하지 않고 해시·URL·페이지 수만 기록한다.
- 인증 파일, `CODEX_HOME` 내용, 캐시 디렉터리는 `.gitignore`.

각 커밋 항목의 형식: **커밋 메시지** / 내용 / 확인 방법.

## 2. M0 — 저장소 골격 (PLAN.md에 없는 사전 단계)

M1 이전에 필요한 기반. 3~4 커밋, 반나절.

### C0.1 `chore: 프로젝트 초기화와 문서 커밋`
- `PLAN.md`, `COMMIT_PLAN.md`, `.gitignore`(node_modules, dist, out, `.codex-home/`, `cache/`, `fixtures/**/*.pdf`), `.editorconfig`, `LICENSE`(개인용, 선택).
- 확인: `git log`에 첫 커밋.

### C0.2 `chore: Electron + Vite + TypeScript 골격`
- `package.json`(npm), `electron-vite` 설정, `src/main`, `src/preload`, `src/renderer` 빈 진입점, TypeScript strict, 경로 별칭 `@shared`.
- Electron 보안 기본값: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, CSP 메타 태그.
- 확인: `npm run dev`로 빈 창이 뜬다. `npm run build`가 통과한다.

### C0.3 `chore: Vitest·ESLint·Prettier·CI 스크립트`
- `npm test`, `npm run lint`, `npm run typecheck`. 자동 테스트 대상 범위(좌표 변환·정규화·예산·캐시)만 다루겠다는 원칙을 `CONTRIBUTING.md` 몇 줄로 기록.
- 확인: 빈 테스트 1개 통과.

### C0.4 `docs: 개발 환경 확인 결과와 실행 안내`
- `docs/environment.md`: 0.1 표의 확인값, Docker Desktop 실행 방법, GROBID 이미지 태그(CRF 우선), Codex 런타임 버전 고정 방침.
- 확인: 문서만.

## 3. M1 — 원문과 문장 연결 (PLAN.md 13절, 3~5일)

목표 시연: PDF에서 드래그하면 우측에 해당 영어 문장이 표시된다. 14~16 커밋.

### 3.1 공유 스키마

#### C1.1 `feat(schema): 캐시 스키마 v1 타입과 JSON Schema`
- `src/shared/schema/`: PLAN 8.2의 객체를 TypeScript 타입 + JSON Schema(ajv)로 정의. 0.3-1에 따라 `Sentence`(추출)와 `SentenceResult`(세대)를 분리. enum은 8.2의 상태값 그대로.
- 확인: 스키마 컴파일 테스트, 샘플 JSON 검증 통과·실패 케이스.

#### C1.2 `feat(cache): 논문 캐시 디렉터리와 원자적 파일 쓰기`
- `userData/cache/papers/<sha256>/` 배치, `manifest.json`, 임시 파일 → rename 원자 교체, 파일 해시 기록. SHA-256 계산.
- 확인: 쓰기 중 예외를 주입해도 기존 파일이 손상되지 않는 테스트.

### 3.2 PDF 열기와 렌더링

#### C1.3 `feat(viewer): PDF 열기 IPC와 PDF.js 페이지 렌더링`
- preload로 노출하는 최소 IPC(`openPdf`, `getPaperState`). renderer에서 `pdfjs-dist` 워커 로드, 페이지 지연 렌더링, 확대율.
- 확인: 40쪽 논문을 열어 스크롤·확대가 된다.

#### C1.4 `feat(viewer): 텍스트 레이어와 페이지 뷰 정보 수집`
- PDF.js `TextLayer` 렌더링, 페이지별 `width/height/rotation/mediaBox/cropBox` 수집 → `Page[]`.
- 확인: 텍스트 드래그 선택이 원문 위치와 맞는다.

#### C1.5 `feat(extract): renderer에서 텍스트 항목 추출과 저장`
- 0.3-6에 따라 renderer의 `getTextContent`(파싱은 PDF.js `PDFWorker`) 수행 → 항목 ID 부여 → IPC로 메인에 전달 → `extraction/<rev>/source-map.json`의 PDF.js 부분 저장. 텍스트 품질 판정(`textQuality`): 유효 글자 비율이 낮으면 `needs_ocr`로 분류하고 이후 단계 중단.
- 확인: 텍스트 PDF와 스캔 PDF 각 1개에서 분류가 갈린다.

### 3.3 GROBID 연결

#### C1.6 `feat(parser): GROBID 서비스 어댑터와 헬스체크`
- loopback `http://127.0.0.1:8070`, `isalive`, 동시 1, 타임아웃, 503이면 5~10초 후 재시도 2회. 기본 이미지 `grobid/grobid:0.9.1-crf`(4GB 할당). 실패 시 0.3-7의 안내 메시지. 이미지 태그·설정 해시를 `Pipeline.parserConfigHash`에 기록.
- 확인: 데몬이 꺼진 상태에서 안내가 뜨고, 켜면 통과한다.

#### C1.7 `feat(parser): processFulltextDocument 호출과 TEI 원본 보존`
- `segmentSentences=1`, `teiCoordinates`를 `s`, `figure`, `formula`, `biblStruct`, `ref`, `persName`으로 반복 지정(허용 목록 전부), `consolidateHeader=0`, `consolidateCitations=0`. 응답을 `original.tei.xml`로 저장.
- 확인: 샘플 1편 TEI에 `<s coords="...">`가 있다.

#### C1.8 `feat(parser): TEI → 섹션·문장·제외 블록·참고문헌 정규화`
- TEI 파싱(fast-xml-parser 등) → `Section[]`, `Sentence[]`(enRaw, order, sectionId, paragraphId, kind), `ExcludedBlock[]`(figure/table/formula/note/header 등), `BibliographicItem[]`. GROBID 좌표를 `Rect{coordinateSpace: grobid_top_left_pdf_units}`로 보존, 페이지 번호를 0-based `pageIndex`로 변환.
- 문장 ID 발급: `sha256(pdfHash + rev + order)` 단축형. 파서 임시 ID를 영구 ID로 쓰지 않는다.
- 확인: 샘플에서 본문 문장 수·제외 블록 수가 수동 집계와 일치. `Fig.`·`et al.` 경계 오류 사례를 fixture로 기록.

### 3.4 정규화와 매핑 (가장 위험한 부분, PLAN 12.1)

#### C1.9 `feat(normalize): 원본↔정규화 문자열 대응표`
- 합자(ﬁ ﬂ), 연속 공백, 줄바꿈, 줄 끝 하이픈 복원 규칙. 모든 변환은 `NormalizationMap`(원본 offset ↔ 정규화 offset)으로 역추적 가능. 수식 기호에는 NFKC를 적용하지 않는다. `normalizerVersion` 고정.
- 확인: 속성 기반 테스트로 `denormalize(normalize(s)) === s`의 범위 대응이 항상 성립.

#### C1.10 `feat(mapping): 좌표계 변환 (GROBID ↔ PDF user space ↔ viewport)`
- top-left/1-based ↔ PDF user space ↔ PDF.js viewport. 회전 0/90/180/270, CropBox 오프셋. `transformVersion` 기록.
- 확인: 회전·CropBox가 있는 합성 PDF fixture에서 왕복 변환 오차 < 0.5pt.

#### C1.11 `feat(mapping): 문장 사각형 → PDF.js 텍스트 항목 후보 검색`
- 같은 페이지, 사각형 확장 여유 내 항목을 후보로. 페이지별 공간 인덱스.
- 확인: 샘플에서 문장당 후보 수 분포와 후보 0건 사례 로그.

#### C1.12 `feat(mapping): 후보 내 문자열 정렬로 SourceSpan 확정`
- 정규화 문자열 기준 순서 정렬(부분 문자열 + 편집 거리 허용). 같은 문자열의 첫 발견 위치에 붙이지 않고 후보 범위 안에서만 대응. `mappingStatus`(`mapped/uncertain/unmapped`)·`mappingConfidence` 산출. UTF-16 offset으로 저장.
- 확인: 정답 표본 fixture(3.5절)에서 매핑 정확도 리포트 출력. 열 경계·페이지 경계 문장 포함.

#### C1.13 `feat(mapping): 인라인 수식 후보 검출과 [EQ_n] 자리표시자`
- 수학 글꼴명·기호 밀도·첨자 위치로 후보 → `EquationPlaceholder`. 확신 낮으면 `math_uncertain`. 단일 변수·약어는 제외 규칙.
- 확인: 수식이 있는 샘플(RAG 논문)에서 검출·오인 목록을 fixture로 기록. 이 수치는 12.3의 "별도 측정" 항목이다.

#### C1.14 `feat(extract): 추출 파이프라인 오케스트레이션과 document.json 확정`
- C1.5~C1.13을 잇는 메인 프로세스 작업: `imported → extracting → mapping` 상태 전이, `extraction/<rev>/document.json`·`source-map.json` 저장, 읽기 순서 경고(5.2) 기록.
- 확인: 샘플 3편이 에러 없이 `mapping` 완료. 재실행 시 같은 rev·같은 ID.

### 3.5 화면 선택 → 문장 ID

#### C1.15 `feat(viewer): 텍스트 레이어 DOM ↔ SourceSpan 연결과 선택 해석`
- 렌더된 span과 항목 ID 대응(1:1 가정 없음). Selection/Range → 문자 범위 → 문장 ID 집합(중복 제거, 본문 순서). 클릭은 문자 위치 → 문장. 공백·제외 블록 선택은 빈 결과.
- 확인: 부분 드래그가 전체 문장으로 확장되고, 여러 줄·페이지 경계 선택이 순서대로 나온다.

#### C1.16 `feat(ui): 우측 패널에 선택 문장 원문·매핑 상태 표시`
- 원문(`en`), `mappingStatus`가 `unmapped`면 "이 부분은 문장 연결을 확인하지 못했습니다". 상단에 단계·진행 표시 자리.
- 확인: M1 시연 조건 충족. 200ms 이내 표시(캐시 조회) 측정 로그.

### 3.6 Codex 연결 검증 (M1 후반)

#### C1.17 `chore(llm): @openai/codex 버전 고정과 프로토콜 바인딩 생성`
- `@openai/codex@0.157.1`(확인 시점 최신)을 의존성으로 고정. **고정한 npm 버전의 바이너리**로 `codex app-server generate-ts`를 실행해 `src/main/llm/codex/protocol/`에 커밋(ChatGPT.app 번들 바이너리는 사용하지 않음). 재생성 스크립트.
- 확인: 생성 타입이 typecheck를 통과. `thread/start`에 `config`·`dynamicTools`가 있는지 기록.

#### C1.18 `feat(llm): 앱 전용 CODEX_HOME과 App Server 자식 프로세스 관리`
- `CODEX_HOME=userData/codex-home`으로 자식 프로세스 실행. 앱이 `config.toml` 생성: `web_search = "disabled"`, `approval_policy = "never"`, `sandbox_mode = "read-only"`, `[features]`에서 `shell_tool`, `unified_exec`, `apps`, `multi_agent`, `goals`, `hooks`, `web_search` off, 플러그인·마켓플레이스 항목 없음. `turn/start`에는 `sandboxPolicy: {type: "readOnly"}`(networkAccess 기본 false). stdio 연결, 초기화, 종료, 크래시 감지.
- 0.4-B의 1순위(`thread/start.config`에 `mcp_servers` 덮어쓰기)가 적용되는지 `mcpServerStatus/list`로 확인. 안 되면 2순위(프로필 2개·프로세스 2개)로 전환하고 결과를 기록.
- 확인: 앱이 띄운 runtime의 유효 도구 목록을 로그로 덤프해 shell·browser·plugin이 없음을 확인.

#### C1.19 `feat(llm): 로그인 상태 확인·로그인 흐름·한도 조회`
- 어댑터 계약(4.2 표)의 인증·한도 부분. `account/read`로 상태, `account/login/start {type: "chatgpt"}` + `account/login/completed` 알림으로 로그인, `account/rateLimits/read`와 `account/rateLimits/updated`로 한도(`usedPercent`, `resetsAt`). UI에 `needs_login` 상태.
- 확인: 앱 내에서 ChatGPT 로그인 1회 후 상태가 `authenticated`. 한도 값이 null이면 "확인 불가".

#### C1.20 `feat(llm): 구조화 출력 스모크 테스트 (도구 없음)`
- 작은 JSON Schema로 1턴 실행 → 응답 검증 → 사용량 기록. `Usage` 객체 저장.
- 확인: 통과 시 M1 완료. 스키마 미지원이면 "기능 확인" 실패로 보고하고 M2 진입 전 대안 검토.

### 3.7 정답 표본 (M1 병행)

#### C1.21 `test(fixtures): 검증 논문 3편의 해시·페이지·정답 매핑 표본`
- PLAN 12.2 후보 3편의 arXiv 버전(vN)·해시·페이지 수 기록. 각 편에서 어려운 사례(열 경계, 페이지 경계, 반복 문자열, 인라인 수식) 포함 총 200개 이상 문장의 수동 정답 매핑을 JSON으로. PDF 자체는 커밋하지 않고 다운로드 스크립트.
- 확인: `npm run eval:mapping`이 12.3의 매핑 정확도를 출력.

**M1 통과 판정**: 매핑 99% 이상·조용한 오매핑 0건·C1.18~C1.20 통과. 미달이면 M2로 가지 않고 C1.11~C1.13을 수정한다(PLAN 13절).

## 4. M2 — 문맥 기반 번역 (2~4일)

목표 시연: 문장 선택 시 논문 맥락에 맞는 저장된 번역이 즉시 표시. 10~11 커밋.

#### C2.1 `feat(llm): 구조화 작업 실행 어댑터 (turn 시작·이벤트·중단·JSON 결과)`
- 4.2 표의 "구조화 작업 실행"·"중단". 작업 ID → 진행 이벤트 스트림 → 최종 JSON + 사용량. Codex 고유 응답을 어댑터 밖으로 내보내지 않는다.
- 확인: 중단 요청이 실제로 턴을 멈추는 테스트.

#### C2.2 `feat(prompt): 프롬프트 템플릿 엔진과 promptVersion`
- 6.5·6.6 초안을 역할 지침/입력 데이터로 분리한 템플릿. 변수 치환, `promptVersion` 해시.
- 확인: 스냅샷 테스트.

#### C2.3 `feat(context): 1차 패스(도구 없음) — 컨텍스트 스키마와 실행`
- 이번 단계는 조사 도구 없이 `Context`(summary, glossary, concepts 없이 unresolved 표시, coverage) 생성. 검증: coverage가 모든 섹션을 덮는지.
- 확인: 샘플 1편에서 `context.json` 생성, 용어집 항목 존재.

#### C2.4 `feat(chunk): 섹션·토큰 기준 청크 분할`
- 1,500~2,500 토큰/청크, 문단 경계 유지, 작은 섹션 병합, 앞뒤 1~2문장 `neighborSentenceIds`. 토크나이저 근사치와 `inputHash`.
- 확인: 청크 합집합 = 본문 문장 전체, 교집합 없음(테스트).

#### C2.5 `feat(translate): 2차 패스 청크 실행과 ChunkResult 스키마`
- 0.3-4의 판별 유니온 스키마(이 단계에서는 `results`만 허용). `SentenceResult{id, ko, note, refs:[], conceptIds, warnings}`.
- 확인: 샘플 1개 청크가 완료된다.

#### C2.6 `feat(validate): 결과 검증기 — ID 집합·자리표시자·인용·문맥 문장 혼입`
- 6.4의 5개 검사. 실패 유형별 `Failure` 코드.
- 확인: 누락·중복·추가 ID, `[EQ_n]` 삭제, 이웃 문장 포함 각각을 잡는 테스트.

#### C2.7 `feat(translate): 실패 수정 턴과 청크 축소 재시도`
- 10절 표: 스키마 오류 → 도구 없는 수정 1회 → 청크 반분 1회 → 실패 표시. 원래 출력 진단 보존.
- 확인: 고의로 깨진 응답을 주입하는 테스트.

#### C2.8 `feat(scheduler): 논문 단위 작업 스케줄러 (동시 1, 앞 섹션부터)`
- `context_pending → translating` 상태 전이, 청크 순차 실행, 결과 `chunks/<id>.json` 원자 저장, manifest 갱신. 완료 청크는 재요청하지 않음.
- 확인: 샘플 1편 완주. 로그에 청크별 입력·출력 토큰·시간 기록(11.2).

#### C2.9 `feat(ui): 번역·해설 표시와 처리 대기 상태`
- 우측 패널에 `ko`, `note`(빈 문자열이면 숨김), 미완료 문장은 "처리 대기". 선택 시 LLM 호출 없음(캐시 조회만).
- 확인: 네트워크를 끊고도 완료 문장은 즉시 표시.

#### C2.10 `feat(ui): 선택한 미완료 청크를 다음 순서로 올리기`
- 9절 정책. 진행 중 작업은 취소하지 않는다.
- 확인: 뒤쪽 섹션 선택 후 다음 청크가 그 섹션에서 시작.

#### C2.11 `test(eval): 용어 일관성·ID 정합성 평가 스크립트`
- 완료 청크 전체에서 용어집 위반·ID 불일치 0건 확인.
- 확인: M2 통과 기준(샘플 1편 완주, 용어 일관성, 선택 시 추가 호출 없음).

### 4.1 품질 묶음 (M2 뒤, 2026-09-27 사용자 의견)

`docs/quality-backlog.md`의 Q0~Q3을 한 번에 고친다. 프롬프트가 바뀌면 컨텍스트와 청크를 다시 만들어야 하므로 재생성을 한 번으로 묶는다. 이 묶음 뒤의 순서는 M4, M3, M5다(PLAN 13절).

#### Q.1 `feat(context): 개념 카드와 용어 허용 표기를 1차 패스에서 받기`
- 용어집 `acceptedKo`, 개념 카드 `concepts`(출처 없는 일반 설명, `researchStatus: unresolved`). 통용 표기 규칙.
- 확인: 빈 카드·중복 카드·없는 이름 연결을 버리는 검증 테스트.

#### Q.2 `feat(translate): 문장 해설을 이름 붙은 칸 넷으로 받고 개념 카드에 잇기`
- 출력 `plain`·`role`·`example`·`deeper`·`conceptIds`. "막힐 때만 짧게" 규칙 삭제. 괄호 원어 표기.
- 확인: 입력에 없는 개념 id는 버리고 경고로 남는다.

#### Q.3 `feat(ui): 해설 칸과 개념 카드를 패널에 표시`
- 쉬운 뜻과 역할은 바로 보이고 사례와 더 깊은 설명은 눌러 펼친다. "일반 설명, 출처 미확인" 표시.
- 확인: 선택 시 추가 호출 없음. 옛 세대의 해설도 그대로 보인다.

#### Q.4 `test(eval): 용어 일관성 검사에 허용 표기 반영`
- 확인: 새 세대에서 용어 위반 수를 다시 잰다.

#### Q.5 실측과 청크 크기
- 샘플 1편을 새로 만들어 시간, 토큰, 한도를 잰다. 출력이 늘어난 만큼 청크 크기와 제한 시간을 다시 본다.

## 5. M3 — 긴 논문·재개·개요 (2~4일)

8~9 커밋.

#### C3.1 `feat(context): 섹션 다이제스트 → 통합 컨텍스트 (계층형 1차 패스)`
- 본문 토큰 > 25,000이면 `SectionDigest` 부분 작업 → 통합 턴. 각 부분에 "이번 범위만 처리" 지시. coverage 장부로 누락 검사.
- 확인: 긴 논문(서베이) 샘플에서 coverage 누락 0.

#### C3.2 `feat(context): 컨텍스트 버전과 영향 청크 재검증`
- `contextVersion` 증가 시 영향 청크를 `pending`으로 되돌리되 기존 결과는 새 버전 완료까지 표시 유지.
- 확인: 버전 변경 테스트.

#### C3.3 `feat(cache): 재시작 복구 — 해시·스키마·inputHash 검증과 running 작업 판정`
- 8.3 규칙. 종료 당시 `running` 청크는 결과 파일 존재 여부로 재개/재시도 분류. 작업 락 파일.
- 확인: 각 단계에서 `kill -9` 후 재시작 시 완료 결과 손실 0, 완료 청크 재호출 0(자동 테스트 + 수동 1회).

#### C3.4 `feat(llm): 대화 재개 실패 시 캐시 기반 새 대화`
- `threadId` 재개 시도 → 실패하면 캐시만으로 새 턴.
- 확인: threadId를 무효화한 테스트.

#### C3.5 `feat(quota): 한도 초과·인증 만료 상태와 자동 재개`
- `waiting_quota`(재개 시각 표시, 시각 이후 재확인), `needs_login`. 자동 결제·크레딧 구매 없음.
- 확인: 한도 응답을 모킹한 테스트.

#### C3.6 `feat(ui): 일시정지·재개·재시도 컨트롤과 실제 진행률`
- 완료 페이지·청크 수 기반 진행률. 유동 단계는 개수 표시.
- 확인: 일시정지 후 재개 시 중복 실행 없음.

#### C3.7 `feat(ui): 개요·용어집 패널`
- 1차 패스 완료 즉시 표시. 탭 또는 접이식.
- 확인: M3 시연.

#### C3.8 `feat(chunk): 출력 잘림·컨텍스트 초과 시 재분할`
- 10절 표 항목. 불완전 결과를 완료로 저장하지 않음.
- 확인: 잘린 응답 주입 테스트.

#### C3.9 `docs: 11.2 실측값 1차 기록`
- 3편 처리의 파싱 시간·첫 번역 시간·전체 시간·토큰·메모리 중앙값과 최악값.

## 6. M4 — 조사된 초보자 해설 (4~7일)

가장 많은 커밋. 12~14 커밋.

### 6.0 조사 방식 변경 (2026-09-28 사용자 승인)

조사를 Codex 내장 검색으로 한다(PLAN 3.3.1). C4.1과 C4.2는 구현했으나 연결하지 않는다. C4.3~C4.10은 하지 않는다. 대신 아래 순서로 한다. C4.11~C4.13은 내용을 맞춰 R4.5~R4.7로 옮긴다.

#### R4.1 `feat(llm): 조사 전용 Codex 실행 방식`
- 실행 인자로 `features.code_mode_host=true`, `web_search="live"`를 준 app-server를 따로 띄운다. 유효 설정을 확인한다. 번역용 프로세스는 그대로 둔다.
- 확인: 번역용 설정 검증이 전과 같이 통과하고, 조사용 설정에서 다른 기능이 켜져 있으면 시작하지 않는다.

#### R4.2 `feat(llm): 조사 턴의 검색 기록 수집`
- 턴 실행기가 `webSearch` 항목을 모아 검색어, 연 주소, 결과 주소를 돌려준다. 다른 도구 항목이 보이면 실패로 처리한다.
- 확인: 가짜 app-server로 검색 항목과 금지 항목을 흉내 낸 테스트.

#### R4.3 `feat(research): 출처 대조와 research.json 저장`
- 모델이 돌려준 출처를 검색 기록과 대조한다. 기록에 없는 주소는 버린다. 읽은 자료와 더 볼 자료를 구분한다.
- 확인: 지어낸 주소를 넣은 테스트.

#### R4.4 `feat(context): 개념 카드 조사 패스`
- 도구 없는 1차 패스 뒤에 개념 카드를 묶음으로 조사해 설명과 출처를 채운다. 실패한 묶음의 카드는 일반 설명으로 남는다.
- 확인: 카드의 `refs`가 모두 저장된 출처를 가리킨다.

#### R4.5 `feat(ui): 개념 카드의 출처 링크`
- 읽은 자료와 더 볼 자료를 나눠 보인다. 링크는 시스템 브라우저로 연다. 출처가 있는 카드는 "일반 설명, 출처 미확인" 표시를 뗀다.

#### R4.6 실측
- 샘플 1편으로 시간, 토큰, 주간 한도 변화를 잰다.

#### R4.7 `test(eval): 해설 표본 검토 시트`
- C4.13과 같다. 통과 판정 기준은 검색 기록에 없는 출처 0, 표본 검토 완료.
- 2026-09-29 사용자 결정: 시트를 만드는 도구만 만든다. 표본 검토는 M5로 옮긴다(C5.6). 같은 날 조사 지침을 고쳐(Q7) 지금 세대의 검토 결과가 새 세대에 맞지 않기 때문이다.
- 계획과 다른 점: 표본 JSON을 저장소에 두지 않는다. 표본은 세대마다 `npm run eval:review`로 뽑는다. 절차는 `docs/review-checklist.md`.

#### R4.8 `feat(research): 번역 중인 논문을 출처에서 제외` (2026-09-29 추가)
- 사용자 의견(Q7)으로 더했다. 앱이 논문 자체를 출처에서 거르고, 조사 지침에 조사의 목적을 적는다. 숫자로 묶는 규칙은 넣지 않는다.
- 새 지침의 실측은 M5에서 Q6과 함께 한다.

**M4 통과 판정(2026-09-29 사용자)**: 사용자가 조사까지 한 세대를 앱에서 확인했다. 자료 링크가 보이고 열린다. 검색 기록에 없는 출처는 0이다(R4.6 실측). 표본 검토는 하지 않았고 M5로 옮겼다. 통과 기준의 "표본 검토 완료"는 채우지 않은 채로 넘어간다.

### 6.1 처음 계획 (기록)

#### C4.1 `feat(research): 예산 장부 — 범위별 상한·예약·확정·복구`
- `Budget`·`RequestReservation` 스키마 구현. 요청 전 예약을 디스크에 확정, 상태 `reserved/sent/succeeded/failed/unknown`, 재시작 시 `unknown`은 소비 처리. 범위(청크·논문·패스) 동시 적용.
- 확인: N+1 차단, 동시 요청, 재시작 후 유지, 캐시 적중 시 외부 예산 미차감 테스트(12.3 "검색 예산" 항목 전체).

#### C4.2 `feat(research): 검색 제공자 인터페이스와 키 없는 제공자 1종 평가`
- `SearchProvider{search(query): Candidate[]}` 계약. free-search-mcp를 참고하되 내부 재시도·다중 엔진 요청이 게이트웨이를 거치는지 확인 가능한 구현만 채택. 결과는 `candidateId`로 발급(0.3-3).
- 확인: 20개 질의 표본의 실패율·차단율 기록. 기준 미달이면 결과를 사용자에게 제시하고 제공자 재결정(PLAN 13절).

#### C4.3 `feat(research): fetch 게이트웨이 — URL 정책·리다이렉트 검사·크기·시간 제한`
- 로컬·사설망·file URL 차단(리다이렉트마다), http(s)만, 응답 크기·시간·본문 길이 상한, 추적 파라미터 정리, 원래/최종 URL 보존.
- 확인: 사설망 리다이렉트 차단 테스트.

#### C4.4 `feat(research): HTML 본문 추출과 PDF 로컬 추출`
- Readability(스크립트 미실행) + 학술 페이지 손실 검사 표본. PDF는 제한 다운로드 후 텍스트 추출.
- 확인: 학술 페이지 10개 표본에서 본문 손실 여부 기록.

#### C4.5 `feat(research): Source·Evidence 발급과 열람 상태`
- `fetch` 성공 시 `sourceId`, 전달 구간마다 `evidenceId`, `read/partial/failed`. `deliveredToJobIds` 기록.
- 확인: 열람 실패 자료에 `sourceId`가 발급되지 않는 테스트.

#### C4.6 `feat(mcp): 작업 전용 MCP 프록시 서버 (search·fetch)`
- 0.3-2의 얇은 프록시. Codex가 stdio로 띄우며, 작업 토큰으로 Electron 메인의 unix socket에 위임. 도구 인자는 `query` 또는 `candidateId`뿐.
- 확인: 토큰 없는 호출 거부, `budget_exhausted` 반환, 2회 연속 거절 후 턴 중단.

#### C4.7 `feat(llm): 작업별 MCP 구성 주입과 유효 도구 확인`
- 0.4-B에 따라 조사용 스레드(`mcp_servers` 포함)와 도구 없는 스레드를 분리. C1.18에서 확정한 방식(스레드별 `config` 또는 프로필 2개)을 사용. `mcpServerStatus/list`로 턴 시작 전 도구 목록을 검사하고 번역·통합 스레드에 `search`·`fetch`가 보이면 턴을 시작하지 않음.
- 확인: 번역 턴에서 search 호출 시도가 불가능함을 로그로 확인.

#### C4.8 `feat(context): 1차 패스 조사 턴 + 도구 없는 통합 턴`
- 6.5 프롬프트 전체. 조사 턴 결과(출처·개념)를 입력으로 고정하고 통합 턴에서 `Context.concepts`·`refs` 생성.
- 확인: `refs`가 모두 실제 `sourceId/evidenceId`인지 검증 통과.

#### C4.9 `feat(validate): 출처 무결성 검증기`
- 7절 5·6: 없는 ID·임의 URL 거절 → 수정 대상. 참고문헌 유래 URL은 `discoveredBy=bibliography`.
- 확인: 가짜 ID 주입 테스트.

#### C4.10 `feat(translate): needsResearch → 보충 조사 → 도구 없는 재완성`
- 0.3-4 판별 유니온. 이미 조사된 개념 필터, 잔여 예산 확인, 보충 조사 작업(청크 1/2/6, 논문 합계 6/12/36), 재시도 턴은 `results`만 허용.
- 확인: 보충 조사 1회 상한과 예산 0 청크의 도구 미노출 테스트.

#### C4.11 `feat(ui): 해설·출처 링크·배경 개념 패널`
- `refs`를 Source에서 해결해 표시. 시스템 브라우저로만 열기. `partial` 출처는 전달 구간만 표시.
- 확인: M4 시연.

#### C4.12 `feat(ui): complete_with_gaps 표시와 unresolved 목록`
- 근거 부족 해설은 보류 표시.

#### C4.13 `test(eval): 해설 표본 30개 검토 시트와 근거 적합성 대조 절차`
- 12.3 체크리스트를 `docs/review-checklist.md`와 표본 JSON으로. 사람 검토 결과 기록 칸.
- 확인: M4 통과 판정(예산 초과 0, 출처 검증 통과, 표본 검토 완료).

## 7. M5 — 개인용 완성·품질 검증 (3~5일)

6~7 커밋.

#### C5.1 `feat(ui): 시작 시 의존 서비스 점검 화면 (Docker/GROBID/Codex 로그인)`
- 각 항목 상태와 조치 안내. 자동 설치 없음.

#### C5.2 `feat(viewer): 회전·확대·다중 선택 회귀 검증과 수정`
- 12.3 "확대·회전·드래그" 항목의 수동 검증 + 발견 버그 수정.

#### C5.3 `feat(errors): 실패 표 전항목 처리 점검 (10절)`
- PDF 손상·암호, 파서 시간초과, 네트워크 jitter 재시도(5/15/45초, 3회, 취소 가능).
- 확인: 각 실패를 주입한 테스트 또는 수동 재현 기록.

#### C5.4 `chore(build): macOS x64 실행 패키지 (electron-builder, 서명 없음)`
- 개인용 `.app`. Codex 런타임과 preload 포함 여부 확인, GROBID는 외부 서비스로 안내.
- 확인: 빌드 산출물을 다른 디렉터리에서 실행.

#### C5.5 `test(e2e): Playwright Electron 최소 시나리오`
- 열기 → 추출 → 선택 → 원문 표시 1개 시나리오.

#### C5.6 `docs: 샘플 3편 전체 평가 결과와 알려진 실패 조건`
- 12.3 표 전체 항목의 실측값, 실패 유형, 미지원 범위(스캔 PDF, 표·그림·수식 해설).
- M4에서 옮겨 온 일(2026-09-29): Q6과 Q7의 조사 지침으로 세대를 다시 만들고, 그 세대로 해설 표본 30개를 검토한다(`docs/review-checklist.md`). 지침 수정은 묶어서 한 번에 하고 조사도 한 번만 다시 돌린다.

#### C5.7 `docs: 실행 안내와 일상 사용 절차`
- README: Docker Desktop 실행 → GROBID 컨테이너 → 앱 실행 → 로그인 → PDF 열기.

## 8. 요약 표

| 단계 | 커밋 수 | 핵심 위험 | 통과 판정 |
|---|---:|---|---|
| M0 골격 | 4 | 없음 | 빈 창·빈 테스트 |
| M1 매핑 | 21 | C1.11~C1.13 매핑·수식 | 매핑 99%, 오매핑 0, Codex 스모크 통과 |
| M2 번역 | 11 | 스키마·ID 검증 | 샘플 1편 완주, 선택 시 호출 없음 |
| 품질 묶음 | 5 | 출력 증가로 인한 시간·한도 | 사용자 해설 표본 검토 |
| M3 재개 | 9 | 재시작 복구 | 강제 종료 후 손실 0 |
| M4 조사 | 10 | 한도 부담, 검색 횟수 미강제 | 기록에 없는 출처 0, 출처 검증 통과. 표본 검토는 M5로 옮김 |
| M5 완성 | 7 | 없음 | 3편 평가·실패 조건 문서화 |
| 합계 | 67 | | |

진행 순서는 M0, M1, M2, 품질 묶음, M4, M3, M5다(2026-09-27 변경).

커밋 수는 실제 작업에서 합쳐지거나 나뉠 수 있다. 순서는 "먼저 검증해야 뒤가 의미 있는" 의존 관계를 따른 것이며, M1의 C1.17~C1.20(Codex 연결)은 매핑 작업과 독립이므로 병행할 수 있다.

## 9. 시작 전 사용자 결정 사항

PLAN.md 14.1의 4개 항목과 이 문서 0.3의 8개 보완점에 대한 승인이 필요하다. 바꾸고 싶은 것만 알려주면 된다. 승인 후 C0.1부터 시작한다.
