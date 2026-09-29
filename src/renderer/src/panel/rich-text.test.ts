import { describe, expect, it } from 'vitest';
import { parseInline, parseRichText } from './rich-text';

const plain = (text: string) => [{ text, bold: false }];

describe('parseInline', () => {
  it('굵게 표시한 부분을 나눈다', () => {
    expect(parseInline('문서를 **토큰마다** 섞는다')).toEqual([
      { text: '문서를 ', bold: false },
      { text: '토큰마다', bold: true },
      { text: ' 섞는다', bold: false },
    ]);
    expect(parseInline('**핵심**')).toEqual([{ text: '핵심', bold: true }]);
  });

  it('짝이 맞지 않거나 빈 표시는 글자 그대로 둔다', () => {
    expect(parseInline('2 ** 3 = 8')).toEqual(plain('2 ** 3 = 8'));
    expect(parseInline('**** 빈 표시')).toEqual(plain('**** 빈 표시'));
    expect(parseInline('')).toEqual([]);
  });
});

describe('parseRichText', () => {
  it('표기가 없는 글은 단락 하나다', () => {
    expect(parseRichText('앞선 세대의 해설이다.')).toEqual([
      { kind: 'paragraph', lines: [plain('앞선 세대의 해설이다.')] },
    ]);
    expect(parseRichText('  \n\n ')).toEqual([]);
  });

  it('빈 줄로 단락을 나누고 단락 안의 줄바꿈은 지킨다', () => {
    expect(parseRichText('첫 단락 첫 줄\n첫 단락 둘째 줄\n\n둘째 단락')).toEqual([
      { kind: 'paragraph', lines: [plain('첫 단락 첫 줄'), plain('첫 단락 둘째 줄')] },
      { kind: 'paragraph', lines: [plain('둘째 단락')] },
    ]);
  });

  it('목록을 읽는다. 빈 줄이 없어도 단락과 나뉜다', () => {
    const blocks = parseRichText(
      '용어부터 푼다.\n- **잠재 문서:** 보이지 않는 선택\n  이어지는 줄\n- 주변화\n1. 첫째\n2) 둘째',
    );
    expect(blocks).toEqual([
      { kind: 'paragraph', lines: [plain('용어부터 푼다.')] },
      {
        kind: 'list',
        ordered: false,
        items: [
          [
            { text: '잠재 문서:', bold: true },
            { text: ' 보이지 않는 선택', bold: false },
            { text: ' 이어지는 줄', bold: false },
          ],
          plain('주변화'),
        ],
      },
      { kind: 'list', ordered: true, items: [plain('첫째'), plain('둘째')] },
    ]);
  });

  it('표를 읽고 칸 수를 머리줄에 맞춘다', () => {
    const blocks = parseRichText(
      '| | A를 볼 때 | B를 볼 때 |\n|---|---:|---:|\n| "1867" | 0.9 | 0.1 |\n| 짧은 줄 | 0.2 |\n| 긴 줄 | 1 | 2 | 3 |\n뒤의 글',
    );
    expect(blocks).toEqual([
      {
        kind: 'table',
        header: [[], plain('A를 볼 때'), plain('B를 볼 때')],
        rows: [
          [plain('"1867"'), plain('0.9'), plain('0.1')],
          [plain('짧은 줄'), plain('0.2'), []],
          [plain('긴 줄'), plain('1'), plain('2')],
        ],
      },
      { kind: 'paragraph', lines: [plain('뒤의 글')] },
    ]);
  });

  it('구분 줄이 없는 세로줄은 표가 아니다', () => {
    expect(parseRichText('| 절댓값 |x|는 표가 아니다 |')).toEqual([
      { kind: 'paragraph', lines: [plain('| 절댓값 |x|는 표가 아니다 |')] },
    ]);
  });

  it('허용하지 않은 표기는 글자 그대로 둔다', () => {
    expect(parseRichText('# 제목\n<b>굵게</b> [링크](https://example.org)')).toEqual([
      {
        kind: 'paragraph',
        lines: [plain('# 제목'), plain('<b>굵게</b> [링크](https://example.org)')],
      },
    ]);
  });

  it('음수로 시작하는 줄은 목록이 아니다', () => {
    expect(parseRichText('-0.5는 음수다')).toEqual([
      { kind: 'paragraph', lines: [plain('-0.5는 음수다')] },
    ]);
  });
});
