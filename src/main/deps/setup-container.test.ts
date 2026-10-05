import { describe, expect, it, vi } from 'vitest';
import { ManagedGrobid } from './setup-container';
import { GROBID_IMAGE } from './docker';

const id = 'a'.repeat(64);
const signal = new AbortController().signal;
function existing(managed: boolean, host = '127.0.0.1', running = true) {
  return JSON.stringify([
    {
      Id: id,
      Config: { Image: GROBID_IMAGE, Labels: managed ? { 'local.paperlens.managed': '1' } : {} },
      State: { Running: running },
      HostConfig: { PortBindings: { '8070/tcp': [{ HostIp: host, HostPort: '8070' }] } },
    },
  ]);
}
describe('container ownership', () => {
  it('repair restarts only a compatible explicitly managed container by ID', async () => {
    const docker = vi.fn((args: string[]) =>
      Promise.resolve(args[0] === 'inspect' ? existing(true) : ''),
    );
    const container = new ManagedGrobid(docker);
    await container.restart(signal);
    expect(docker.mock.calls[1]?.[0]).toEqual(['restart', '--time', '5', id]);
  });
  it('repair refuses an unowned container without restarting it', async () => {
    const docker = vi.fn(() => Promise.resolve(existing(false)));
    await expect(new ManagedGrobid(docker).restart(signal)).rejects.toThrow(
      'container_name_conflict',
    );
    expect(docker).toHaveBeenCalledOnce();
  });
  it('creates labelled local-only container and stops its exact ID', async () => {
    const docker = vi.fn((args: string[]) => Promise.resolve(args[0] === 'run' ? id : ''));
    const container = new ManagedGrobid(docker);
    await container.start(signal);
    await container.stop();
    expect(docker.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining([
        '127.0.0.1:8070:8070',
        '--label',
        'local.paperlens.managed=1',
        '--platform',
        'linux/amd64',
        '-m',
        '4g',
      ]),
    );
    expect(docker.mock.calls[2]?.[0]).toEqual(['stop', '--time', '5', id]);
  });
  it('reuses but does not stop a compatible user-managed container', async () => {
    const docker = vi.fn((args: string[]) =>
      Promise.resolve(args[0] === 'ps' ? id : existing(false)),
    );
    const container = new ManagedGrobid(docker);
    await container.start(signal);
    await container.stop();
    expect(docker.mock.calls.map(([args]) => args[0])).toEqual(['ps', 'inspect']);
  });
  it('restarts its stopped container without creating a duplicate', async () => {
    const docker = vi.fn((args: string[]) =>
      Promise.resolve(
        args[0] === 'ps' ? id : args[0] === 'inspect' ? existing(true, '127.0.0.1', false) : '',
      ),
    );
    const container = new ManagedGrobid(docker);
    await container.start(signal);
    await container.stop();
    expect(docker.mock.calls.map(([args]) => args[0])).toEqual(['ps', 'inspect', 'start', 'stop']);
  });
  it('refuses a conflicting public port and does not modify it', async () => {
    const docker = vi.fn((args: string[]) =>
      Promise.resolve(args[0] === 'ps' ? id : existing(false, '0.0.0.0')),
    );
    const container = new ManagedGrobid(docker);
    await expect(container.start(signal)).rejects.toThrow('container_name_conflict');
    await container.stop();
    expect(docker).toHaveBeenCalledTimes(2);
  });
});
