import type { DependencyReport } from '@shared/ipc';

/**
 * 의존 서비스 점검 화면의 뷰 모델(COMMIT_PLAN C5.1). DOM을 모르는 순수 변환이다.
 * 항목 셋(Docker, GROBID, Codex 로그인)마다 상태와 사용자가 할 일을 적는다. 자동 설치는 없다.
 * 하나라도 안 되면 화면을 펼쳐 보여 준다.
 */
export interface CheckRow {
  key: 'docker' | 'grobid' | 'codex';
  label: string;
  state: 'ok' | 'warn' | 'fail' | 'checking';
  /** 한 줄 상태 */
  text: string;
  /** 사용자가 할 일. 없으면 null */
  guidance: string | null;
  /** 단추. start_grobid는 받아 둔 이미지로 컨테이너를 띄운다. login은 계정 패널과 같다 */
  action: { label: string; kind: 'start_grobid' | 'login' } | null;
}

export interface ChecksView {
  rows: CheckRow[];
  allOk: boolean;
  /** 접힌 제목. "의존 서비스 점검 · 문제 1건" */
  title: string;
}

export const CHECKING_VIEW: ChecksView = {
  rows: (['docker', 'grobid', 'codex'] as const).map((key) => ({
    key,
    label: key === 'docker' ? 'Docker' : key === 'grobid' ? 'GROBID' : 'Codex 로그인',
    state: 'checking',
    text: '확인 중…',
    guidance: null,
    action: null,
  })),
  allOk: false,
  title: '의존 서비스 점검 · 확인 중',
};

export function checksView(report: DependencyReport): ChecksView {
  const rows: CheckRow[] = [];

  const docker = report.docker;
  rows.push({
    key: 'docker',
    label: 'Docker',
    state: docker.ok ? 'ok' : 'fail',
    text: docker.message,
    guidance: docker.ok
      ? null
      : docker.reason === 'not_installed'
        ? 'Docker Desktop을 설치하세요. GROBID(논문 구조 분석)가 Docker 안에서 돕니다.'
        : 'Docker Desktop을 실행하세요. 실행된 뒤 "다시 확인"을 누르세요.',
    action: null,
  });

  const grobid = report.grobid;
  if (grobid.ok) {
    rows.push({
      key: 'grobid',
      label: 'GROBID',
      state: 'ok',
      text: `연결됨${grobid.version ? ` (${grobid.version})` : ''}`,
      guidance: null,
      action: null,
    });
  } else {
    const canStart = docker.ok && docker.imagePresent === true;
    rows.push({
      key: 'grobid',
      label: 'GROBID',
      state: 'fail',
      text: docker.containerRunning
        ? '컨테이너는 돌고 있지만 아직 응답하지 않습니다. 준비되기까지 수십 초 걸립니다'
        : '연결할 수 없습니다',
      guidance: !docker.ok
        ? 'Docker가 먼저 실행돼야 합니다.'
        : docker.imagePresent === false
          ? '터미널에서 docker pull grobid/grobid:0.9.1-crf 로 이미지를 받은 뒤 "GROBID 띄우기"를 누르세요.'
          : docker.containerRunning
            ? '잠시 뒤 "다시 확인"을 누르세요.'
            : '"GROBID 띄우기"를 누르면 받아 둔 이미지로 컨테이너를 띄웁니다. 준비까지 수십 초 걸립니다.',
      action:
        canStart && !docker.containerRunning
          ? { label: 'GROBID 띄우기', kind: 'start_grobid' }
          : null,
    });
  }

  const codex = report.codex;
  if (codex.runtime === 'disabled') {
    rows.push({
      key: 'codex',
      label: 'Codex 로그인',
      state: 'warn',
      text: 'LLM을 쓰지 않도록 설정돼 있습니다 (PAPERLENS_NO_CODEX)',
      guidance: '번역·해설은 만들 수 없고 저장된 결과만 볼 수 있습니다.',
      action: null,
    });
  } else if (codex.runtime === 'stopped') {
    rows.push({
      key: 'codex',
      label: 'Codex 로그인',
      state: 'fail',
      text: 'Codex App Server가 실행 중이 아닙니다',
      guidance: '앱을 다시 시작하세요. 계속되면 터미널 로그의 [codex] 줄을 확인하세요.',
      action: null,
    });
  } else if (codex.account.state === 'authenticated') {
    rows.push({
      key: 'codex',
      label: 'Codex 로그인',
      state: 'ok',
      text: `로그인됨${codex.account.email ? ` (${codex.account.email})` : ''}${codex.account.plan ? ` · ${codex.account.plan}` : ''}`,
      guidance: null,
      action: null,
    });
  } else if (codex.account.state === 'needs_login') {
    rows.push({
      key: 'codex',
      label: 'Codex 로그인',
      state: 'fail',
      text: '로그인이 필요합니다',
      guidance: '"로그인"을 누르면 브라우저가 열립니다. ChatGPT 계정으로 로그인하세요.',
      action: { label: '로그인', kind: 'login' },
    });
  } else {
    rows.push({
      key: 'codex',
      label: 'Codex 로그인',
      state: 'fail',
      text: `계정 상태를 확인할 수 없습니다: ${codex.account.reason}`,
      guidance: '잠시 뒤 "다시 확인"을 누르세요.',
      action: null,
    });
  }

  const problems = rows.filter((r) => r.state === 'fail').length;
  const allOk = problems === 0;
  return {
    rows,
    allOk,
    title: allOk ? '의존 서비스 점검 · 모두 정상' : `의존 서비스 점검 · 문제 ${problems}건`,
  };
}
