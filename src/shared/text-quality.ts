import type { TextQuality } from './schema';

/**
 * PDF.js 텍스트 항목만으로 페이지·문서의 텍스트 품질을 판정한다 (PLAN 5.1-5).
 * - needs_ocr: 유효 글자가 거의 없다(스캔 이미지 페이지). 이후 단계를 진행하지 않는다.
 * - garbled: 글자는 있으나 사설 영역(PUA)·대체 문자·제어 문자 비율이 높다(글꼴 인코딩 실패). 진행하지 않는다.
 * - sparse: 글자가 적다(그림·표만 있는 페이지 등). 페이지 단위 정보이며 문서 진행은 막지 않는다.
 * - ok: 그 외.
 * 임계값은 샘플 3편과 스캔 PDF 1편으로 정한 초기값이다. 측정값이 쌓이면 조정한다.
 */
export const TEXT_QUALITY_THRESHOLDS = {
  /** 페이지의 공백 제외 글자 수가 이 값 미만이면 needs_ocr */
  minCharsForText: 20,
  /** 페이지의 공백 제외 글자 수가 이 값 미만이면 sparse */
  minCharsForOk: 200,
  /** 유효 글자 비율이 이 값 미만이면 garbled */
  minValidRatio: 0.7,
  /** 문서에서 needs_ocr(또는 garbled) 페이지 비율이 이 값을 넘으면 문서도 같은 판정 */
  majority: 0.5,
} as const;

export interface PageTextStats {
  pageIndex: number;
  itemCount: number;
  /** 공백을 제외한 글자 수 (UTF-16 코드 유닛이 아니라 코드 포인트) */
  chars: number;
  /** chars 중 사설 영역·대체 문자·제어 문자가 아닌 글자 수 */
  validChars: number;
}

const INVALID_CHAR = /[\p{Co}\p{Cc}\p{Cn}�]/u;
const WHITESPACE = /\s/u;

export function pageTextStats(pageIndex: number, strs: readonly string[]): PageTextStats {
  let chars = 0;
  let validChars = 0;
  for (const s of strs) {
    for (const ch of s) {
      if (WHITESPACE.test(ch)) continue;
      chars++;
      if (!INVALID_CHAR.test(ch)) validChars++;
    }
  }
  return { pageIndex, itemCount: strs.length, chars, validChars };
}

export function classifyPage(stats: PageTextStats): TextQuality {
  const t = TEXT_QUALITY_THRESHOLDS;
  if (stats.chars < t.minCharsForText) return 'needs_ocr';
  if (stats.validChars / stats.chars < t.minValidRatio) return 'garbled';
  if (stats.chars < t.minCharsForOk) return 'sparse';
  return 'ok';
}

/** 페이지 판정을 문서 판정으로 합친다. 페이지가 없으면 needs_ocr. */
export function classifyDocument(pageQualities: readonly TextQuality[]): TextQuality {
  const n = pageQualities.length;
  if (n === 0) return 'needs_ocr';
  const count = (q: TextQuality): number => pageQualities.filter((p) => p === q).length;
  if (count('needs_ocr') / n > TEXT_QUALITY_THRESHOLDS.majority) return 'needs_ocr';
  if (count('garbled') / n > TEXT_QUALITY_THRESHOLDS.majority) return 'garbled';
  if (count('ok') === 0) return 'sparse';
  return 'ok';
}

/** 이 품질이면 추출 이후 단계(GROBID·매핑·번역)를 진행하지 않는다. */
export function haltsPipeline(quality: TextQuality): boolean {
  return quality === 'needs_ocr' || quality === 'garbled';
}
