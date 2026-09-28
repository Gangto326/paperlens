import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CandidateRegistry,
  duckDuckGoHtmlProvider,
  plainHttp,
  type SearchFailureKind,
} from './search-provider';

// 키 없는 검색 제공자 평가(COMMIT_PLAN C4.2). 실제 외부 요청을 보내므로 기본 검사에서는 돌지 않는다.
// 질의 20개를 간격을 두고 1회씩 보낸다. 다시 보내지 않는다.
// 실행:
//   PAPERLENS_SEARCH_LIVE=1 [PAPERLENS_LIVE_OUT=<dir>] [PAPERLENS_SEARCH_GAP_MS=3000] \
//   npx vitest run src/main/research/search-eval.live.test.ts --silent=false --disableConsoleIntercept
const enabled = Boolean(process.env['PAPERLENS_SEARCH_LIVE']);
const outDir = process.env['PAPERLENS_LIVE_OUT'];
const gapMs = Number(process.env['PAPERLENS_SEARCH_GAP_MS'] ?? '3000');

/** 샘플 논문(2005.11401)의 개념 카드에서 고른 질의. 영어, 한국어, 한국어 영상 찾기를 섞었다. */
const QUERIES: { query: string; group: 'en' | 'ko' | 'video' }[] = [
  { query: 'dense passage retrieval bi-encoder explained', group: 'en' },
  { query: 'maximum inner product search FAISS tutorial', group: 'en' },
  { query: 'BART denoising sequence-to-sequence pre-training', group: 'en' },
  { query: 'marginal likelihood latent variable model tutorial', group: 'en' },
  { query: 'beam search decoding explained', group: 'en' },
  { query: 'BM25 ranking function explained', group: 'en' },
  { query: 'exact match metric open-domain question answering', group: 'en' },
  { query: 'retrieval-augmented generation 설명', group: 'ko' },
  { query: '파인튜닝 사전학습 차이 예시', group: 'ko' },
  { query: '밀집 검색 dense retrieval 바이인코더', group: 'ko' },
  { query: '빔 서치 디코딩 쉽게 설명', group: 'ko' },
  { query: 'BM25 알고리즘 설명 예시', group: 'ko' },
  { query: '주변화 marginalization 잠재 변수 설명', group: 'ko' },
  { query: '오픈 도메인 질의응답 open-domain QA 설명', group: 'ko' },
  { query: '언어 모델 환각 hallucination 사례', group: 'ko' },
  { query: 'RAG 검색 증강 생성 강의 site:youtube.com', group: 'video' },
  { query: '파인튜닝 설명 강의 site:youtube.com', group: 'video' },
  { query: 'seq2seq 트랜스포머 강의 한국어 site:youtube.com', group: 'video' },
  { query: 'BM25 설명 site:youtube.com', group: 'video' },
  { query: 'FAISS 벡터 검색 강의 site:youtube.com', group: 'video' },
];

const hasHangul = (text: string): boolean => /[가-힣]/.test(text);

describe.skipIf(!enabled)('검색 제공자 평가 (실제 외부 요청)', () => {
  it('질의 20개의 실패율·차단율을 기록한다', async () => {
    const registry = new CandidateRegistry();
    const rows: {
      query: string;
      group: string;
      ok: boolean;
      kind: SearchFailureKind | null;
      results: number;
      korean: number;
      youtube: number;
      elapsedMs: number;
      top: string[];
    }[] = [];
    for (const [i, q] of QUERIES.entries()) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
      const started = Date.now();
      const outcome = await duckDuckGoHtmlProvider.search(q.query, {
        http: plainHttp,
        region: 'kr-kr',
      });
      const elapsedMs = Date.now() - started;
      const candidates = outcome.ok
        ? registry.issue(outcome.results, {
            provider: duckDuckGoHtmlProvider.name,
            query: q.query,
            jobId: 'search_eval',
          })
        : [];
      const row = {
        query: q.query,
        group: q.group,
        ok: outcome.ok,
        kind: outcome.ok ? null : outcome.kind,
        results: candidates.length,
        korean: candidates.filter((c) => hasHangul(`${c.title} ${c.snippet}`)).length,
        youtube: candidates.filter((c) =>
          /(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(new URL(c.url).hostname),
        ).length,
        elapsedMs,
        top: candidates.slice(0, 3).map((c) => new URL(c.url).hostname),
      };
      rows.push(row);
      console.log(`[search-eval] ${JSON.stringify(row)}`);
    }
    const failed = rows.filter((r) => !r.ok);
    const summary = {
      provider: duckDuckGoHtmlProvider.name,
      at: new Date().toISOString(),
      queries: rows.length,
      failed: failed.length,
      blocked: failed.filter((r) => r.kind === 'blocked').length,
      empty: rows.filter((r) => r.ok && r.results === 0).length,
      meanResults: rows.reduce((n, r) => n + r.results, 0) / rows.length,
      meanElapsedMs: Math.round(rows.reduce((n, r) => n + r.elapsedMs, 0) / rows.length),
      candidates: registry.size,
    };
    console.log(`[search-eval] summary ${JSON.stringify(summary)}`);
    if (outDir) {
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(
        join(outDir, 'search-eval.json'),
        JSON.stringify({ summary, rows }, null, 1),
      );
    }
    expect(rows).toHaveLength(QUERIES.length);
  }, 600_000);
});
