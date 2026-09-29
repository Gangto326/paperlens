import type { Reference, Source } from '@shared/schema';
import { normalizeUrl, standingOf, type ResearchTrace } from '../llm/research-trace';

/**
 * 출처 대조(PLAN 3.3.1, COMMIT_PLAN R4.3). 모델이 돌려준 출처를 그 턴의 검색 기록과 맞춰 본다.
 * - 열람 기록이 있는 주소는 "읽은 자료"(fetchStatus read)다.
 * - 검색 결과에만 나온 주소는 "더 볼 자료"(fetchStatus not_read)다. 앱은 내용을 확인하지 못했다.
 * - 기록에 없는 주소는 저장하지 않고 거절 목록에 남긴다. 모델이 기억으로 쓴 주소일 수 있다.
 * - 번역 중인 논문 자체는 저장하지 않는다(self-source.ts). 거절 목록에 self_paper로 남긴다.
 * 제목은 기록의 것을 쓴다. 기록에 제목이 없을 때만 모델이 적은 제목을 쓴다.
 */
export interface ClaimedSource {
  url: string;
  title: string;
  kind: string;
  language: string;
  supports: string;
}

export interface RejectedSource {
  url: string;
  reason: 'not_in_trace' | 'invalid_url' | 'self_paper';
}

export interface CheckedSources {
  /** 읽은 자료를 가리키는 참조 */
  refs: Reference[];
  /** 더 볼 자료를 가리키는 참조 */
  furtherRefs: Reference[];
  rejected: RejectedSource[];
}

/** 세대 하나의 출처 장부. 같은 주소는 같은 id를 쓴다. 한 번 읽은 자료는 읽은 자료로 남는다. */
export class SourceRegistry {
  private readonly byKey = new Map<string, Source>();

  constructor(
    existing: readonly Source[] = [],
    private readonly now: () => Date = () => new Date(),
  ) {
    for (const source of existing) {
      const key = normalizeUrl(source.finalUrl);
      if (key !== null) this.byKey.set(key, { ...source });
    }
  }

  sources(): Source[] {
    return [...this.byKey.values()].map((s) => ({ ...s }));
  }

  check(
    claimed: readonly ClaimedSource[],
    trace: ResearchTrace,
    origin: { jobId: string; isSelf?: (source: { url: string; title: string }) => boolean },
  ): CheckedSources {
    const out: CheckedSources = { refs: [], furtherRefs: [], rejected: [] };
    const seen = new Set<string>();
    for (const claim of claimed) {
      const key = normalizeUrl(claim.url);
      if (key === null) {
        out.rejected.push({ url: claim.url, reason: 'invalid_url' });
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      const standing = standingOf(trace, claim.url);
      if (standing === 'absent') {
        out.rejected.push({ url: claim.url, reason: 'not_in_trace' });
        continue;
      }
      const entry = trace.results.find((r) => normalizeUrl(r.url) === key);
      const isSelf = origin.isSelf;
      if (
        isSelf &&
        [claim.title, entry?.title ?? ''].some((title) => isSelf({ url: claim.url, title }))
      ) {
        out.rejected.push({ url: claim.url, reason: 'self_paper' });
        continue;
      }
      let source = this.byKey.get(key);
      if (!source) {
        source = {
          id: `src_${this.byKey.size + 1}`,
          discoveredUrl: entry?.url ?? claim.url.trim(),
          finalUrl: entry?.url ?? claim.url.trim(),
          title: entry && entry.title !== '' ? entry.title : claim.title.trim(),
          publisher: entry?.domain ?? null,
          sourceType: claim.kind.trim(),
          discoveredBy: 'search',
          discoveredAt: this.now().toISOString(),
          fetchStatus: 'not_read',
          evidenceIds: [],
          language: claim.language.trim() === '' ? null : claim.language.trim(),
          jobId: origin.jobId,
        };
        this.byKey.set(key, source);
      }
      if (standing === 'viewed') source.fetchStatus = 'read';
      const ref: Reference = {
        sourceId: source.id,
        evidenceIds: [],
        supports: claim.supports.trim(),
      };
      (standing === 'viewed' ? out.refs : out.furtherRefs).push(ref);
    }
    return out;
  }
}
