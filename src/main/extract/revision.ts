import { sha256Hex, stableStringify } from '../cache/hash';

/**
 * extraction revision ID 입력. 같은 PDF에 같은 도구 버전·설정이면 같은 rev가 나와야 한다
 * (COMMIT_PLAN C1.14: 재실행 시 같은 rev·같은 문장 ID).
 * C1.5에서 PDF.js 쪽, C1.9에서 normalizerVersion(source-map.json의 대응표가 이 버전에 묶인다)을
 * 넣었다. C1.14에서 parserName/parserVersion/parserConfigHash/segmenterVersion을 더한다.
 */
export interface RevisionInput {
  pdfjsVersion: string;
  textExtractorVersion: string;
  normalizerVersion: string;
}

export function computeExtractionRevision(input: RevisionInput): string {
  return `r${sha256Hex(stableStringify(input)).slice(0, 12)}`;
}
