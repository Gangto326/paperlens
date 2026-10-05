import { GROBID_CONTAINER, GROBID_IMAGE, GROBID_RUN_ARGS, GROBID_INSPECT_FORMAT } from './docker';
import { containerFacts } from './setup-diagnosis';

type Docker = (args: string[], signal: AbortSignal, timeout?: number) => Promise<string>;
/** Reuse compatible containers, but stop only containers carrying our explicit ownership label. */
export class ManagedGrobid {
  private ownedId: string | null = null;
  constructor(private readonly docker: Docker) {}
  async restart(signal: AbortSignal): Promise<void> {
    const raw = await this.docker(
      ['inspect', '--format', GROBID_INSPECT_FORMAT, GROBID_CONTAINER],
      signal,
    );
    const facts = containerFacts(raw);
    const id = (JSON.parse(raw) as Array<{ Id?: string }>)[0]?.Id;
    if (!facts.managed || !facts.compatible || !id || !/^[a-f0-9]{12,64}$/.test(id))
      throw new Error('container_name_conflict');
    this.ownedId = id;
    await this.docker(['restart', '--time', '5', id], signal, 20_000);
  }
  async start(signal: AbortSignal): Promise<void> {
    const ids = await this.docker(
      ['ps', '-a', '--filter', `name=^/${GROBID_CONTAINER}$`, '--format', '{{.ID}}'],
      signal,
    );
    if (ids.trim()) {
      const raw = await this.docker(
        ['inspect', '--format', GROBID_INSPECT_FORMAT, GROBID_CONTAINER],
        signal,
      );
      const items = JSON.parse(raw) as Array<{
        Id: string;
        Config: { Image: string; Labels?: Record<string, string> };
        State: { Running: boolean };
        HostConfig: { PortBindings?: Record<string, Array<{ HostIp: string; HostPort: string }>> };
      }>;
      const item = items[0];
      const ports = item?.HostConfig.PortBindings?.['8070/tcp'];
      if (
        !item ||
        item.Config.Image !== GROBID_IMAGE ||
        ports?.length !== 1 ||
        ports[0]?.HostIp !== '127.0.0.1' ||
        ports[0]?.HostPort !== '8070'
      )
        throw new Error('container_name_conflict');
      if (item.Config.Labels?.['local.paperlens.managed'] === '1') this.ownedId = item.Id;
      if (!item.State.Running) await this.docker(['start', GROBID_CONTAINER], signal);
    } else {
      this.ownedId = (
        await this.docker(
          [...GROBID_RUN_ARGS.slice(0, -1), '--label', 'local.paperlens.managed=1', GROBID_IMAGE],
          signal,
          30_000,
        )
      ).trim();
    }
  }
  async stop(): Promise<void> {
    if (this.ownedId && /^[a-f0-9]{12,64}$/.test(this.ownedId)) {
      await this.docker(
        ['stop', '--time', '5', this.ownedId],
        AbortSignal.timeout(8000),
        8000,
      ).catch(() => undefined);
    }
  }
}
