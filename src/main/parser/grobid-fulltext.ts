import type { PaperCacheStore } from '../cache/paper-cache-store';
import type { GrobidClient } from './grobid-client';

/**
 * processFulltextDocument 요청 매개변수 (PLAN 5.1-3, COMMIT_PLAN C1.7).
 * - segmentSentences=1: <s> 단위 문장 분리.
 * - teiCoordinates: 허용 목록 전부를 반복 지정. 문장(s)·그림·수식·참고문헌·인용 참조·인명 좌표.
 * - consolidateHeader/Citations=0: 외부 서지 보정을 끄고 원문 파싱 결과를 보존한다.
 * 값을 바꾸면 parserConfigHash가 바뀌어 새 extraction revision이 된다(C1.14).
 */
export const FULLTEXT_TEI_COORDINATES = [
  's',
  'figure',
  'formula',
  'biblStruct',
  'ref',
  'persName',
] as const;

export const FULLTEXT_PARAMS: Record<string, string | string[]> = {
  segmentSentences: '1',
  consolidateHeader: '0',
  consolidateCitations: '0',
  teiCoordinates: [...FULLTEXT_TEI_COORDINATES],
};

export interface FulltextResult {
  tei: string;
  parserConfigHash: string;
  /** 응답에 <s coords="…">가 하나라도 있는지 (문장 좌표 확보 여부) */
  hasSentenceCoords: boolean;
  elapsedMs: number;
}

/** PDF 바이트를 GROBID에 보내 TEI 문자열을 받는다. 동시 1개·503 재시도는 client가 맡는다. */
export async function processFulltext(
  client: GrobidClient,
  pdfBytes: Uint8Array,
  fileName = 'paper.pdf',
): Promise<FulltextResult> {
  const t0 = Date.now();
  const form = new FormData();
  form.append('input', new Blob([pdfBytes], { type: 'application/pdf' }), fileName);
  for (const [key, value] of Object.entries(FULLTEXT_PARAMS)) {
    for (const v of Array.isArray(value) ? value : [value]) form.append(key, v);
  }
  const res = await client.request('/api/processFulltextDocument', {
    method: 'POST',
    body: form,
    headers: { Accept: 'application/xml' },
  });
  const tei = await res.text();
  if (!/<TEI[\s>]/.test(tei)) {
    throw new Error(`GROBID 응답이 TEI가 아닙니다: ${tei.slice(0, 120)}`);
  }
  return {
    tei,
    parserConfigHash: client.parserConfigHash(FULLTEXT_PARAMS),
    hasSentenceCoords: /<s\b[^>]*\bcoords="/.test(tei),
    elapsedMs: Date.now() - t0,
  };
}

/** TEI 원본을 extraction/<rev>/original.tei.xml에 저장하고 manifest.files에 해시를 기록한다. */
export async function saveOriginalTei(
  store: PaperCacheStore,
  pdfSha256: string,
  extractionRevision: string,
  tei: string,
): Promise<string> {
  const path = store.extractionPath(pdfSha256, extractionRevision, 'original.tei.xml');
  const sha = await store.writeText(path, tei);
  await store.updateManifest(pdfSha256, (m) => store.recordFile(m, pdfSha256, path, sha));
  return path;
}
