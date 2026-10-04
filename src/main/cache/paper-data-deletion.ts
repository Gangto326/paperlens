import { promises as fs } from 'node:fs';
import type { PaperCacheStore } from './paper-cache-store';

/** 논문별 쓰기와 삭제를 조율한다. 확인 창이 열린 동안에도 새 작업을 막는다. */
export class PaperDataDeletion {
  private readonly active = new Map<string, number>();
  private readonly deleting = new Set<string>();

  constructor(
    private readonly store: PaperCacheStore,
    private readonly busy: (sha: string) => boolean,
  ) {}

  isDeleting(sha: string): boolean {
    return this.deleting.has(sha);
  }

  async run<T>(sha: string, action: () => Promise<T>): Promise<T> {
    if (this.isDeleting(sha)) throw new Error('이 논문의 데이터 삭제를 확인 중입니다.');
    this.active.set(sha, (this.active.get(sha) ?? 0) + 1);
    try {
      return await action();
    } finally {
      const count = (this.active.get(sha) ?? 1) - 1;
      if (count) this.active.set(sha, count);
      else this.active.delete(sha);
    }
  }

  async remove(sha: string, confirm: () => Promise<boolean>): Promise<boolean> {
    const path = this.store.paperDir(sha); // 해시 검증: 임의 경로 삭제 금지
    if (this.isDeleting(sha)) throw new Error('이미 삭제 확인 중입니다.');
    if (this.active.has(sha) || this.busy(sha))
      throw new Error(
        '분석·번역·자료 검색 또는 추가 설명 생성이 진행 중입니다. 작업이 멈추거나 끝난 뒤 삭제해 주세요.',
      );
    this.deleting.add(sha);
    try {
      if (!(await confirm())) return false;
      if (this.active.has(sha) || this.busy(sha))
        throw new Error('진행 중인 작업이 있습니다. 작업이 끝난 뒤 삭제해 주세요.');
      await fs.rm(path, { recursive: true, force: true });
      return true;
    } finally {
      this.deleting.delete(sha);
    }
  }
}
