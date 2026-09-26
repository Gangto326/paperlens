import { describe, expect, it } from 'vitest';
import {
  classifyDocument,
  classifyPage,
  haltsPipeline,
  pageTextStats,
  TEXT_QUALITY_THRESHOLDS,
} from './text-quality';

const para = 'Retrieval-augmented generation for knowledge-intensive NLP tasks. '.repeat(5);

describe('pageTextStats', () => {
  it('공백을 세지 않고 사설 영역·대체 문자를 무효로 센다', () => {
    const s = pageTextStats(0, ['ab c', '�x']);
    expect(s).toEqual({ pageIndex: 0, itemCount: 2, chars: 6, validChars: 4 });
  });
  it('서로게이트 쌍은 한 글자로 센다', () => {
    expect(pageTextStats(0, ['𝑥']).chars).toBe(1);
  });
});

describe('classifyPage', () => {
  it('빈 페이지·쪽 번호만 있는 페이지는 needs_ocr', () => {
    expect(classifyPage(pageTextStats(0, []))).toBe('needs_ocr');
    expect(classifyPage(pageTextStats(0, ['12']))).toBe('needs_ocr');
  });
  it('본문 분량이면 ok, 적으면 sparse', () => {
    expect(classifyPage(pageTextStats(0, [para]))).toBe('ok');
    expect(classifyPage(pageTextStats(0, ['Figure 3: Results on NQ and TQA.']))).toBe('sparse');
  });
  it('사설 영역 글자 비율이 높으면 garbled', () => {
    const pua = ''.repeat(100);
    expect(classifyPage(pageTextStats(0, [pua, 'abc']))).toBe('garbled');
    const ratio = TEXT_QUALITY_THRESHOLDS.minValidRatio;
    expect(ratio).toBeGreaterThan(0.5);
  });
});

describe('classifyDocument', () => {
  it('페이지가 없으면 needs_ocr', () => {
    expect(classifyDocument([])).toBe('needs_ocr');
  });
  it('과반이 needs_ocr이면 문서도 needs_ocr', () => {
    expect(classifyDocument(['needs_ocr', 'needs_ocr', 'sparse'])).toBe('needs_ocr');
    expect(classifyDocument(['needs_ocr', 'ok'])).toBe('ok');
  });
  it('과반이 garbled이면 garbled, ok가 하나도 없으면 sparse', () => {
    expect(classifyDocument(['garbled', 'garbled', 'ok'])).toBe('garbled');
    expect(classifyDocument(['sparse', 'needs_ocr'])).toBe('sparse');
  });
});

describe('haltsPipeline', () => {
  it('needs_ocr·garbled만 중단', () => {
    expect(haltsPipeline('needs_ocr')).toBe(true);
    expect(haltsPipeline('garbled')).toBe(true);
    expect(haltsPipeline('sparse')).toBe(false);
    expect(haltsPipeline('ok')).toBe(false);
  });
});
