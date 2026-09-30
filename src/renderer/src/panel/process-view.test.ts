import { describe, expect, it } from 'vitest';
import type { ProcessEvent, TranslationSnapshot } from '@shared/ipc';
import {
  INITIAL_PROCESS,
  applyProcessEvent,
  clockText,
  processFromSnapshot,
  processView,
  type ProcessModel,
} from './process-view';

const SHA = 'a'.repeat(64);
const snapshot = (
  state: TranslationSnapshot['state'],
  statuses: ('pending' | 'complete' | 'failed')[],
): TranslationSnapshot => ({
  pdfSha256: SHA,
  state,
  generationId: statuses.length ? 'gen_1' : null,
  chunks: statuses.map((status, i) => ({ id: `chunk_${i}`, status, sentenceIds: [`s${i}`] })),
  results: {},
});
const play = (model: ProcessModel, events: ProcessEvent[]): ProcessModel =>
  events.reduce(applyProcessEvent, model);

describe('processView', () => {
  it('논문이 준비되지 않았으면 단추가 없다', () => {
    expect(processView(INITIAL_PROCESS)).toEqual({ stage: '', button: null });
  });

  it('처음 연 논문은 번역 시작 단추를 보인다', () => {
    const model = processFromSnapshot(snapshot('mapping', ['pending', 'pending']));
    expect(processView(model)).toEqual({
      stage: '번역 대기 · 0/2 청크',
      button: { label: '번역 시작', action: 'start', disabled: false },
    });
  });

  it('진행률은 끝난 청크 수다. 컨텍스트 단계에는 숫자를 만들지 않는다', () => {
    let model = processFromSnapshot(snapshot('mapping', ['pending', 'pending', 'pending']));
    model = play(model, [
      { type: 'state', pdfSha256: SHA, state: 'context_pending' },
      { type: 'context', pdfSha256: SHA, status: 'running', message: null },
    ]);
    expect(processView(model)).toEqual({
      stage: '논문 문맥 작성 중',
      button: { label: '멈춤', action: 'stop', disabled: false },
    });
    model = play(model, [
      { type: 'context', pdfSha256: SHA, status: 'done', message: null },
      {
        type: 'research',
        pdfSha256: SHA,
        status: 'running',
        researched: 0,
        sources: 0,
        message: null,
      },
    ]);
    expect(processView(model).stage).toBe('개념 자료 조사 중');
    model = play(model, [
      {
        type: 'research',
        pdfSha256: SHA,
        status: 'done',
        researched: 3,
        sources: 7,
        message: null,
      },
      { type: 'state', pdfSha256: SHA, state: 'translating' },
      { type: 'plan', pdfSha256: SHA, total: 3 },
      { type: 'chunkStarted', pdfSha256: SHA, chunkId: 'chunk_0', total: 3 },
    ]);
    expect(processView(model).stage).toBe('번역 중 0/3 청크');
    model = play(model, [
      {
        type: 'chunkFinished',
        pdfSha256: SHA,
        chunkId: 'chunk_0',
        ok: true,
        completed: 1,
        failed: 0,
        total: 3,
        sentenceIds: ['s0'],
      },
      {
        type: 'chunkFinished',
        pdfSha256: SHA,
        chunkId: 'chunk_1',
        ok: false,
        completed: 1,
        failed: 1,
        total: 3,
        sentenceIds: [],
      },
    ]);
    expect(processView(model).stage).toBe('번역 중 1/3 청크 · 실패 1');
  });

  it('멈춤을 요청하면 단추를 잠그고 안내한다', () => {
    const model: ProcessModel = {
      ...processFromSnapshot(snapshot('translating', ['complete', 'pending'])),
      running: true,
      phase: 'translating',
      stopRequested: true,
    };
    expect(processView(model)).toEqual({
      stage: '번역 중 1/2 청크 · 이 청크가 끝나면 멈춤',
      button: { label: '멈춤', action: 'stop', disabled: true },
    });
  });

  it('완료되면 단추가 없고, 일부 실패나 멈춤이면 이어서 할 수 있다', () => {
    const finished = (
      reason: 'complete' | 'complete_with_gaps' | 'paused' | 'waiting_quota' | 'needs_login',
      state: TranslationSnapshot['state'],
      completed: number,
      failed: number,
    ): ProcessModel =>
      play({ ...processFromSnapshot(snapshot('translating', [])), running: true }, [
        {
          type: 'finished',
          pdfSha256: SHA,
          reason,
          message: null,
          state,
          completed,
          failed,
          total: 3,
        },
      ]);
    expect(processView(finished('complete', 'complete', 3, 0))).toEqual({
      stage: '번역 완료 · 3/3 청크',
      button: null,
    });
    expect(processView(finished('complete_with_gaps', 'complete_with_gaps', 2, 1))).toEqual({
      stage: '번역 완료(일부 실패) · 2/3 청크 · 실패 1',
      button: { label: '번역 이어서', action: 'start', disabled: false },
    });
    expect(processView(finished('paused', 'paused', 1, 0)).stage).toBe('멈춤 · 1/3 청크');
    expect(processView(finished('waiting_quota', 'waiting_quota', 1, 1)).stage).toBe(
      '한도 대기 · 1/3 청크 · 실패 1',
    );
    expect(processView(finished('needs_login', 'needs_login', 0, 0)).button?.label).toBe(
      '번역 이어서',
    );
  });

  it('다시 연 논문은 저장된 청크 수로 시작한다', () => {
    const model = processFromSnapshot(snapshot('paused', ['complete', 'complete', 'pending']));
    expect(processView(model)).toEqual({
      stage: '멈춤 · 2/3 청크',
      button: { label: '번역 이어서', action: 'start', disabled: false },
    });
    expect(
      processView(processFromSnapshot(snapshot('complete', ['complete', 'complete']))),
    ).toEqual({ stage: '번역 완료 · 2/2 청크', button: null });
  });

  it('시작하지 못한 실행은 알고 있던 청크 수를 지우지 않는다', () => {
    const model = play(processFromSnapshot(snapshot('paused', ['complete', 'pending'])), [
      {
        type: 'finished',
        pdfSha256: SHA,
        reason: 'busy',
        message: '다른 논문을 처리 중입니다',
        state: 'paused',
        completed: 0,
        failed: 0,
        total: 0,
      },
    ]);
    expect(model).toMatchObject({ completed: 1, total: 2, message: '다른 논문을 처리 중입니다' });
  });
});

describe('자동 재개 대기(C3.5)', () => {
  it('한도 대기와 로그인 대기를 단계 글에 보여 주고, 처리가 다시 시작되면 지운다', () => {
    let model = processFromSnapshot(snapshot('waiting_quota', ['complete', 'pending']));
    model = applyProcessEvent(model, {
      type: 'waiting',
      pdfSha256: SHA,
      kind: 'quota',
      resumeAt: '2026-09-30T04:31:00.000Z',
    });
    expect(processView(model).stage).toContain(
      `${clockText('2026-09-30T04:31:00.000Z')}에 한도를 다시 확인합니다`,
    );
    model = applyProcessEvent(model, {
      type: 'waiting',
      pdfSha256: SHA,
      kind: 'quota',
      resumeAt: null,
    });
    expect(processView(model).stage).toContain('한도를 주기적으로 확인합니다');
    model = applyProcessEvent(model, {
      type: 'waiting',
      pdfSha256: SHA,
      kind: 'login',
      resumeAt: null,
    });
    expect(processView(model).stage).toContain('로그인하면 이어서 합니다');
    model = applyProcessEvent(model, {
      type: 'context',
      pdfSha256: SHA,
      status: 'running',
      message: null,
    });
    expect(model.waiting).toBeNull();
    model = applyProcessEvent(model, {
      type: 'waiting',
      pdfSha256: null,
      kind: 'none',
      resumeAt: null,
    });
    expect(model.waiting).toBeNull();
  });
});
