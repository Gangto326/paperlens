import { describe, expect, it } from 'vitest';
import type { DependencyReport } from '@shared/ipc';
import { checksView } from './checks-view';

const report = (over: Partial<DependencyReport> = {}): DependencyReport => ({
  docker: {
    ok: true,
    reason: 'ok',
    message: 'Docker 28 실행 중',
    imagePresent: true,
    containerRunning: false,
  },
  grobid: { ok: true, version: '0.9.1' },
  codex: {
    runtime: 'running',
    account: { state: 'authenticated', method: 'chatgpt', email: 'a@b.c', plan: 'plus' },
  },
  checkedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

describe('checksView', () => {
  it('모두 정상이면 할 일과 단추가 없다', () => {
    const v = checksView(report());
    expect(v.allOk).toBe(true);
    expect(v.title).toBe('의존 서비스 점검 · 모두 정상');
    expect(v.rows.map((r) => [r.key, r.state, r.guidance, r.action])).toEqual([
      ['docker', 'ok', null, null],
      ['grobid', 'ok', null, null],
      ['codex', 'ok', null, null],
    ]);
    expect(v.rows[2]?.text).toBe('로그인됨 (a@b.c) · plus');
  });

  it('Docker가 꺼져 있으면 GROBID도 Docker부터 안내하고 띄우기 단추를 주지 않는다', () => {
    const v = checksView(
      report({
        docker: {
          ok: false,
          reason: 'not_running',
          message: '데몬 없음',
          imagePresent: null,
          containerRunning: null,
        },
        grobid: { ok: false, reason: 'unreachable', message: 'x', guidance: 'y' },
      }),
    );
    expect(v.title).toBe('의존 서비스 점검 · 문제 2건');
    expect(v.rows[0]?.guidance).toContain('Docker Desktop을 실행');
    expect(v.rows[1]).toMatchObject({ state: 'fail', action: null });
    expect(v.rows[1]?.guidance).toContain('Docker가 먼저');
  });

  it('이미지가 있고 컨테이너가 없으면 띄우기 단추, 돌고 있으면 기다리라고 한다', () => {
    const down = {
      ok: false as const,
      reason: 'unreachable' as const,
      message: 'x',
      guidance: 'y',
    };
    const v = checksView(report({ grobid: down }));
    expect(v.rows[1]?.action).toEqual({ label: 'GROBID 띄우기', kind: 'start_grobid' });
    const starting = checksView(
      report({
        grobid: down,
        docker: {
          ok: true,
          reason: 'ok',
          message: 'm',
          imagePresent: true,
          containerRunning: true,
        },
      }),
    );
    expect(starting.rows[1]?.action).toBeNull();
    expect(starting.rows[1]?.text).toContain('아직 응답하지 않습니다');
    const noImage = checksView(
      report({
        grobid: down,
        docker: {
          ok: true,
          reason: 'ok',
          message: 'm',
          imagePresent: false,
          containerRunning: false,
        },
      }),
    );
    expect(noImage.rows[1]?.action).toBeNull();
    expect(noImage.rows[1]?.guidance).toContain('docker pull');
  });

  it('Codex는 로그인 필요·런타임 없음·LLM 끔을 구분한다', () => {
    expect(
      checksView(report({ codex: { runtime: 'running', account: { state: 'needs_login' } } }))
        .rows[2],
    ).toMatchObject({ state: 'fail', action: { kind: 'login' } });
    expect(
      checksView(report({ codex: { runtime: 'stopped', account: { state: 'needs_login' } } }))
        .rows[2],
    ).toMatchObject({ state: 'fail', action: null, text: 'Codex App Server가 실행 중이 아닙니다' });
    const off = checksView(
      report({ codex: { runtime: 'disabled', account: { state: 'unavailable', reason: 'x' } } }),
    );
    expect(off.rows[2]?.state).toBe('warn');
    expect(off.allOk).toBe(true);
  });
});
