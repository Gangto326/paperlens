import { COORD_TRANSFORM_VERSION } from '@shared/geometry/coords';
import { ALIGNMENT_VERSION } from '@shared/mapping/align';
import { CANDIDATE_SEARCH_VERSION } from '@shared/mapping/candidates';
import { EQUATION_DETECTOR_VERSION } from '@shared/mapping/equations';
import { NORMALIZER_VERSION } from '@shared/normalize/normalizer';
import { sha256Hex, stableStringify } from '../cache/hash';
import { TEI_NORMALIZER_VERSION } from '../parser/tei-normalize';

export const PARSER_NAME = 'grobid';

/**
 * 문장 분리기 버전. 문장 경계는 GROBID의 segmentSentences(<s>)가 정하고(요청 설정은 parserConfigHash에 포함)
 * tei-normalize가 그것을 문장 객체로 옮기므로, 여기서는 TEI 정규화기 버전을 쓴다.
 */
export const SEGMENTER_VERSION = `grobid-s+tei-normalize/${TEI_NORMALIZER_VERSION}`;

/**
 * extraction revision ID 입력. 같은 PDF에 같은 도구 버전·설정이면 같은 rev가 나와야 한다
 * (COMMIT_PLAN C1.14: 재실행 시 같은 rev·같은 문장 ID).
 * - PDF.js 쪽(C1.5): pdfjsVersion·textExtractorVersion.
 * - 정규화(C1.9): normalizerVersion(source-map.json의 대응표가 이 버전에 묶인다).
 * - 파서(C1.14): parserName·parserConfigHash(이미지 태그+요청 설정)·segmenterVersion. 실제로 떠 있는 GROBID의
 *   버전은 텍스트 추출 시점(GROBID 없이도 진행)에는 알 수 없어 rev에 넣지 않고 Pipeline.parserVersion에만
 *   기록한다. 안내한 이미지 태그와 다르면 document.json 경고로 남긴다.
 * - 매핑(C1.10~C1.13)·TEI 정규화(C1.8) 모듈 버전: 규칙이 바뀌면 문장 ID·스팬이 달라지므로 rev도 바뀐다.
 */
export interface RevisionInput {
  pdfjsVersion: string;
  textExtractorVersion: string;
  normalizerVersion: string;
  parserName: string;
  parserConfigHash: string;
  segmenterVersion: string;
  teiNormalizerVersion: string;
  coordTransformVersion: string;
  candidateSearchVersion: string;
  alignmentVersion: string;
  equationDetectorVersion: string;
}

/** 현재 코드의 모듈 버전으로 RevisionInput을 채운다. 실행마다 달라지는 값은 인자로 받는다. */
export function revisionInputFor(runtime: {
  pdfjsVersion: string;
  textExtractorVersion: string;
  parserConfigHash: string;
}): RevisionInput {
  return {
    pdfjsVersion: runtime.pdfjsVersion,
    textExtractorVersion: runtime.textExtractorVersion,
    normalizerVersion: NORMALIZER_VERSION,
    parserName: PARSER_NAME,
    parserConfigHash: runtime.parserConfigHash,
    segmenterVersion: SEGMENTER_VERSION,
    teiNormalizerVersion: TEI_NORMALIZER_VERSION,
    coordTransformVersion: COORD_TRANSFORM_VERSION,
    candidateSearchVersion: CANDIDATE_SEARCH_VERSION,
    alignmentVersion: ALIGNMENT_VERSION,
    equationDetectorVersion: EQUATION_DETECTOR_VERSION,
  };
}

export function computeExtractionRevision(input: RevisionInput): string {
  return `r${sha256Hex(stableStringify(input)).slice(0, 12)}`;
}
