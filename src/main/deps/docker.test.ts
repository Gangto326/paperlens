import { describe, expect, it } from 'vitest';
import { checkDocker, GROBID_RUN_ARGS, startGrobidContainer, type Exec } from './docker';

const fake = (
  table: Record<string, { stdout?: string; error?: Partial<NodeJS.ErrnoException> }>,
): Exec & { calls: string[] } => {
  const calls: string[] = [];
  const exec: Exec = (file, args) => {
    const key = `${file} ${args.slice(0, 2).join(' ')}`;
    calls.push(key);
    const entry = Object.entries(table).find(([k]) => key.startsWith(k))?.[1] ?? {};
    const error = entry.error
      ? Object.assign(new Error(String(entry.error.message ?? 'x')), entry.error)
      : null;
    return Promise.resolve({ stdout: entry.stdout ?? '', code: error ? null : 0, error });
  };
  return Object.assign(exec, { calls });
};

describe('checkDocker', () => {
  it('명령이 없으면 not_installed, 데몬이 없으면 not_running', async () => {
    const missing = await checkDocker(
      fake({ 'docker info': { error: { code: 'ENOENT', message: 'spawn docker ENOENT' } } }),
    );
    expect(missing).toMatchObject({ ok: false, reason: 'not_installed', imagePresent: null });
    const down = await checkDocker(
      fake({ 'docker info': { error: { message: 'Cannot connect to the Docker daemon\nmore' } } }),
    );
    expect(down).toMatchObject({ ok: false, reason: 'not_running' });
    expect(down.message).toContain('Cannot connect');
    expect(down.message).not.toContain('more');
  });

  it('데몬이 응답하면 이미지와 컨테이너를 본다', async () => {
    const exec = fake({
      'docker info': { stdout: '28.0.1\n' },
      'docker image': { stdout: 'grobid/grobid:0.9.1-crf\nother:latest\n' },
      'docker ps': { stdout: 'something\n' },
    });
    expect(await checkDocker(exec)).toEqual({
      ok: true,
      reason: 'ok',
      message: 'Docker 28.0.1 실행 중',
      imagePresent: true,
      containerRunning: false,
    });
  });
});

describe('startGrobidContainer', () => {
  it('이미지가 없으면 내려받지 않고 안내한다', async () => {
    const exec = fake({
      'docker info': { stdout: '1' },
      'docker image': { stdout: '' },
      'docker ps': { stdout: '' },
    });
    const result = await startGrobidContainer(exec);
    expect(result.started).toBe(false);
    expect(result.message).toContain('docker pull');
    expect(exec.calls.some((c) => c.startsWith('docker run'))).toBe(false);
  });

  it('이미지가 있으면 고정 인자로 띄우고, 이미 돌고 있으면 다시 띄우지 않는다', async () => {
    const exec = fake({
      'docker info': { stdout: '1' },
      'docker image': { stdout: 'grobid/grobid:0.9.1-crf' },
      'docker ps': { stdout: '' },
      'docker run': { stdout: 'abc' },
    });
    expect((await startGrobidContainer(exec)).started).toBe(true);
    expect(exec.calls.at(-1)).toBe(`docker ${GROBID_RUN_ARGS.slice(0, 2).join(' ')}`);
    const running = fake({
      'docker info': { stdout: '1' },
      'docker image': { stdout: 'grobid/grobid:0.9.1-crf' },
      'docker ps': { stdout: 'paperlens-grobid' },
    });
    const again = await startGrobidContainer(running);
    expect(again.started).toBe(true);
    expect(again.message).toContain('이미');
    expect(running.calls.some((c) => c.startsWith('docker run'))).toBe(false);
  });
});
