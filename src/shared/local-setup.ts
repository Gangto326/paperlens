export type SetupPhase =
  | 'idle'
  | 'checking'
  | 'downloading_docker'
  | 'install_docker'
  | 'starting_docker'
  | 'downloading_grobid'
  | 'starting_grobid'
  | 'ready'
  | 'cancelled'
  | 'error';
export type SetupAction = 'prepare' | 'cancel' | 'open_docker' | 'open_installer' | 'install_wsl';
export interface SetupState {
  phase: SetupPhase;
  platform: string;
  arch: string;
  memoryGB: number;
  busy: boolean;
  message: string;
  progress: number | null;
  errorCode: string | null;
  autoStart: boolean;
}
export interface SetupAdvice {
  explanation: string;
  action: 'prepare' | 'open_docker' | 'install_wsl' | 'none';
}
export const SETUP_ACTIONS: readonly SetupAction[] = [
  'prepare',
  'cancel',
  'open_docker',
  'open_installer',
  'install_wsl',
];
export const SETUP_STEPS = ['Docker 설치', 'Docker 실행', '논문 분석기 받기', '준비 완료'] as const;
export function setupStep(phase: SetupPhase): number {
  if (phase === 'starting_docker') return 1;
  if (phase === 'downloading_grobid' || phase === 'starting_grobid') return 2;
  if (phase === 'ready') return 3;
  return 0;
}

/** Offline instructions are the primary support path, including when GPT is unavailable. */
export function installationSteps(platform: string): string[] {
  return platform === 'darwin'
    ? [
        '“자동 준비 시작”을 누르세요. 이 Mac에 맞는 Docker 설치 파일을 공식 배포처에서 받습니다. 인터넷 속도에 따라 몇 분 걸립니다.',
        'Docker 창이 열리면 고래 모양 Docker 아이콘을 Applications(응용 프로그램) 폴더로 드래그하세요. 복사가 끝날 때까지 기다리세요. 창이 안 보이면 “설치 파일 다시 열기”를 누르세요.',
        '설치가 확인되면 PaperLens가 Docker를 엽니다. macOS에서 “열기”를 물으면 Docker인지 확인하고 열기를 누르세요. 암호나 Touch ID 요청은 macOS 창에서만 승인하세요.',
        'Docker 약관을 읽고 동의할 경우 Accept를 누르세요. 설정 선택 화면에서는 권장 설정(Recommended settings)을 선택하세요. 계정 만들기 화면에 Skip 또는 Skip for now가 있으면 건너뛸 수 있습니다.',
        'PaperLens로 돌아오세요. “Docker 실행” 다음 “논문 분석기 받기” 단계가 자동으로 진행됩니다. 준비를 멈췄거나 앱을 다시 켰다면 “자동 준비 시작”을 다시 누르세요.',
      ]
    : [
        '“자동 준비 시작”을 누르세요. Windows용 Docker 설치 파일을 공식 배포처에서 받고 설치 창을 엽니다. 인터넷 속도에 따라 몇 분 걸립니다.',
        'Windows가 이 앱의 변경을 허용할지 물으면 게시자가 Docker인지 확인하고 “예”를 누르세요. Docker 설치 창에서 WSL 2 사용 옵션이 있으면 선택하고, Install 또는 OK로 설치를 진행하세요.',
        '설치 완료 화면에서 재시작을 요구하면 작업 중인 문서를 저장한 뒤 재시작하세요. 컴퓨터가 켜지면 PaperLens를 다시 열고 “자동 준비 시작”을 누르세요.',
        'Docker에서 WSL 설치·업데이트가 필요하다고 하면 아래 “Windows 실행 환경 설치·업데이트”를 누르세요. Windows 승인 창에서 “예”를 누르세요. 완료 후 재부팅이 필요할 수 있습니다.',
        'Docker 약관을 읽고 동의할 경우 Accept를 누르세요. 계정 만들기 화면에 Skip 또는 Skip for now가 있으면 건너뛸 수 있습니다. PaperLens로 돌아오면 논문 분석기를 자동으로 받습니다.',
      ];
}
export const SETUP_TROUBLESHOOTING = [
  [
    'Windows에서 Linux 컨테이너가 필요하다고 해요',
    '화면 오른쪽 아래 시계 옆의 숨겨진 아이콘 표시(∧)를 누르고 Docker 고래 아이콘을 오른쪽 클릭하세요. “Switch to Linux containers”가 있으면 선택하세요. Docker가 다시 준비된 후 “자동 준비 시작”을 누르세요. “Switch to Windows containers”라고 보이면 이미 올바른 상태입니다.',
  ],
  [
    '이 운영체제를 지원하지 않는다고 해요',
    'Mac은 Apple 메뉴 → 이 Mac에 관하여에서 버전을 확인하고 시스템 설정 → 일반 → 소프트웨어 업데이트에서 가능한 업데이트를 확인하세요. Windows는 설정 → 시스템 → 정보에서 시스템 종류와 버전을 확인하고 Windows 업데이트를 확인하세요. Windows ARM과 Linux용 자동 설치는 아직 지원하지 않습니다. 조직에서 업데이트를 관리하거나 컴퓨터가 더 이상 업데이트를 지원하지 않으면 이 PC에서 준비를 진행하기 어려울 수 있습니다.',
  ],

  [
    '다운로드가 멈추거나 실패했어요',
    '인터넷 연결과 저장 공간을 확인하세요. “준비 중단” 후 “자동 준비 시작”을 다시 누르세요. 완료되지 않은 Docker 설치 파일은 다시 받으며, GROBID는 이미 받은 부분을 재사용할 수 있습니다. VPN이나 회사 네트워크에서 차단됐다면 허용된 다른 네트워크를 이용하거나 관리자에게 Docker 다운로드 허용을 요청하세요.',
  ],
  [
    '설치했는데 다음 단계로 넘어가지 않아요',
    'Docker 창에 약관 동의나 승인 요청이 남아 있는지 확인하세요. “Docker 열기”를 누르고 화면의 안내를 마친 다음 기다리세요. 15분이 지나 준비가 멈췄다면 “자동 준비 시작”으로 이어갈 수 있습니다.',
  ],
  [
    'Windows에서 가상화가 꺼져 있다고 해요',
    'Ctrl + Shift + Esc로 작업 관리자를 열고 “성능 → CPU → 가상화”를 확인하세요. “사용 안 함”이라면 문서를 저장하고 “설정 → 시스템 → 복구 → 고급 시작 옵션 → 지금 다시 시작 → 문제 해결 → 고급 옵션 → UEFI 펌웨어 설정”으로 이동하세요. Virtualization, Intel VT-x 또는 AMD SVM 항목을 Enabled로 바꾸고 저장 후 재시작하세요. 메뉴가 없거나 회사 PC라면 임의로 다른 설정을 바꾸지 말고 관리자에게 “Docker용 하드웨어 가상화 활성화”를 요청하세요.',
  ],
  [
    '메모리 부족 또는 분석기가 종료됐다고 해요',
    '사용하지 않는 프로그램을 닫으세요. 이 앱은 RAM 8GB 이상을 권장합니다. Docker의 Settings → Resources에 Memory 항목이 있으면 4GB 이상을 배정하세요. Windows의 WSL 2 방식에는 이 슬라이더가 없을 수 있습니다. 설정 후 “자동 준비 시작”을 다시 누르세요.',
  ],
  [
    '같은 이름의 분석기 또는 포트가 사용 중이라고 해요',
    '다른 PaperLens 창에서 분석 중인지 확인하세요. 이 앱은 다른 프로그램이나 출처를 확인할 수 없는 컨테이너를 삭제하지 않습니다. 다른 앱의 분석을 마친 뒤 다시 시도하세요.',
  ],
  [
    'GPT 도움을 사용할 수 없어요',
    '설치는 ChatGPT 로그인 없이도 됩니다. 이 안내대로 진행하세요. GPT 설명이 필요하면 계정 메뉴에서 ChatGPT 로그인 후 돌아오세요. 사용 한도를 다 썼을 때도 아래 안내와 준비 버튼은 그대로 사용할 수 있습니다.',
  ],
] as const;
