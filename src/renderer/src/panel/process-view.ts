import type { ProcessEvent, TranslationSnapshot } from '@shared/ipc';
import type { PaperState } from '@shared/schema';

/**
 * 처리 단계 표시와 시작·멈춤 단추의 뷰 모델(C2.9, PLAN 9절). DOM을 모르는 순수 변환이다.
 * 진행률은 실제로 끝난 청크 수만 쓴다. 컨텍스트 작성처럼 끝을 알 수 없는 단계는 백분율을 만들지 않는다.
 */
export interface ProcessModel {
  /** 문장 색인을 읽어 처리를 시작할 수 있는 논문이 열려 있는지 */
  ready: boolean;
  running: boolean;
  stopRequested: boolean;
  state: PaperState | null;
  phase: 'idle' | 'context' | 'research' | 'translating' | 'finished';
  completed: number;
  failed: number;
  total: number;
  message: string | null;
  /** 자동 재개를 기다리는 중이면 그 종류와 다음 확인 시각(C3.5) */
  waiting: { kind: 'quota' | 'login'; resumeAt: string | null } | null;
}

export const INITIAL_PROCESS: ProcessModel = {
  ready: false,
  running: false,
  stopRequested: false,
  state: null,
  phase: 'idle',
  completed: 0,
  failed: 0,
  total: 0,
  message: null,
  waiting: null,
};

/** 열린 논문의 저장 상태로 처음 모델을 만든다. */
export function processFromSnapshot(snapshot: TranslationSnapshot): ProcessModel {
  const completed = snapshot.chunks.filter((c) => c.status === 'complete').length;
  const failed = snapshot.chunks.filter((c) => c.status === 'failed').length;
  return {
    ...INITIAL_PROCESS,
    ready: true,
    state: snapshot.state,
    phase: snapshot.state === 'complete' ? 'finished' : 'idle',
    completed,
    failed,
    total: snapshot.chunks.length,
  };
}

export function applyProcessEvent(model: ProcessModel, event: ProcessEvent): ProcessModel {
  switch (event.type) {
    case 'state':
      return { ...model, state: event.state };
    case 'context':
      if (event.status === 'running') {
        return { ...model, running: true, phase: 'context', message: null, waiting: null };
      }
      if (event.status === 'failed') return { ...model, message: event.message };
      return { ...model, running: true, phase: 'translating' };
    case 'research':
      if (event.status === 'running') {
        return { ...model, running: true, phase: 'research', message: null };
      }
      if (event.status === 'stopped') return { ...model, message: event.message };
      return { ...model, running: true, phase: 'translating' };
    case 'waiting':
      return {
        ...model,
        waiting: event.kind === 'none' ? null : { kind: event.kind, resumeAt: event.resumeAt },
      };
    case 'plan':
      return { ...model, running: true, phase: 'translating', total: event.total };
    case 'chunkStarted':
      return { ...model, running: true, phase: 'translating', total: event.total };
    case 'chunkFinished':
      return {
        ...model,
        completed: event.completed,
        failed: event.failed,
        total: event.total,
      };
    case 'finished':
      return {
        ...model,
        running: false,
        stopRequested: false,
        state: event.state,
        phase: 'finished',
        // 시작하지 못한 실행(busy 등)은 청크 수를 모른다. 알고 있던 값을 지우지 않는다.
        completed: event.total > 0 ? event.completed : model.completed,
        failed: event.total > 0 ? event.failed : model.failed,
        total: event.total > 0 ? event.total : model.total,
        message: event.message,
      };
  }
}

const STATE_TEXT: Partial<Record<PaperState, string>> = {
  complete: '번역 완료',
  complete_with_gaps: '번역 완료(일부 실패)',
  paused: '멈춤',
  needs_login: '로그인 필요',
  waiting_quota: '한도 대기',
  failed: '실패',
};

/** "9월 30일 13:05"처럼 사용자 시간대의 시각. 읽지 못하는 값은 그대로 보여 준다. */
export function clockText(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${at.getMonth() + 1}월 ${at.getDate()}일 ${two(at.getHours())}:${two(at.getMinutes())}`;
}

export interface ProcessView {
  stage: string;
  button: { label: string; action: 'start' | 'stop'; disabled: boolean } | null;
}

export function processView(model: ProcessModel): ProcessView {
  if (!model.ready) return { stage: '', button: null };
  const progress = model.total > 0 ? ` ${model.completed}/${model.total}` : '';
  const failed = model.failed > 0 ? ` · 실패 ${model.failed}` : '';
  if (model.running) {
    const stage =
      model.phase === 'context'
        ? '논문 문맥 작성 중'
        : model.phase === 'research'
          ? '개념 자료 조사 중'
          : `번역 중${progress} 청크${failed}`;
    return {
      stage: model.stopRequested ? `${stage} · 이 청크가 끝나면 멈춤` : stage,
      button: { label: '멈춤', action: 'stop', disabled: model.stopRequested },
    };
  }
  const name = model.state ? STATE_TEXT[model.state] : undefined;
  const base = name ?? '번역 대기';
  const waiting =
    model.waiting === null
      ? ''
      : model.waiting.kind === 'login'
        ? ' · 로그인하면 이어서 합니다'
        : model.waiting.resumeAt === null
          ? ' · 한도를 주기적으로 확인합니다'
          : ` · ${clockText(model.waiting.resumeAt)}에 한도를 다시 확인합니다`;
  const stage = `${base}${model.total > 0 ? ` ·${progress} 청크${failed}` : ''}${waiting}`;
  if (model.state === 'complete') return { stage, button: null };
  const resumable = model.completed > 0 || model.failed > 0 || name !== undefined;
  return {
    stage,
    button: { label: resumable ? '번역 이어서' : '번역 시작', action: 'start', disabled: false },
  };
}
