/**
 * 해설과 개념 카드의 글을 단락, 목록, 표로 나눈다(docs/quality-backlog.md Q9). DOM을 모르는 순수 변환이다.
 * 모델에게 허용한 표기만 읽는다. 빈 줄로 나눈 단락, "- "와 "1. " 목록, "| 칸 | 칸 |" 표, **굵게**.
 * 그 밖의 표기(제목, 링크, HTML)는 글자 그대로 보인다. 글은 textContent로만 넣으므로 실행되지 않는다.
 * 표기가 없는 글(앞선 세대)은 단락 하나가 된다.
 */
export interface InlinePart {
  text: string;
  bold: boolean;
}

export type RichBlock =
  | { kind: 'paragraph'; lines: InlinePart[][] }
  | { kind: 'list'; ordered: boolean; items: InlinePart[][] }
  | { kind: 'table'; header: InlinePart[][]; rows: InlinePart[][][] };

const BOLD = /\*\*(.+?)\*\*/g;

export function parseInline(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let last = 0;
  for (const m of text.matchAll(BOLD)) {
    const inner = m[1] ?? '';
    if (inner.trim() === '') continue;
    if (m.index > last) parts.push({ text: text.slice(last, m.index), bold: false });
    parts.push({ text: inner, bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), bold: false });
  return parts;
}

const BULLET = /^\s*[-•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const cellsOf = (line: string): string[] => {
  const m = TABLE_ROW.exec(line);
  return (m?.[1] ?? '').split('|').map((cell) => cell.trim());
};

export function parseRichText(text: string): RichBlock[] {
  const blocks: RichBlock[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[i + 1] ?? '')) {
      const header = cellsOf(line).map(parseInline);
      const rows: InlinePart[][][] = [];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i] ?? '')) {
        const cells = cellsOf(lines[i] ?? '');
        // 칸 수가 머리줄과 다르면 맞춘다. 남는 칸은 버리고 모자란 칸은 비운다.
        rows.push(header.map((_, c) => parseInline(cells[c] ?? '')));
        i += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = !bullet;
      const pattern = ordered ? NUMBERED : BULLET;
      const items: InlinePart[][] = [];
      while (i < lines.length) {
        const current = lines[i] ?? '';
        const m = pattern.exec(current);
        if (m) {
          items.push(parseInline((m[1] ?? '').trim()));
        } else if (
          current.trim() !== '' &&
          /^\s+/.test(current) &&
          !BULLET.test(current) &&
          !NUMBERED.test(current)
        ) {
          // 들여 쓴 줄은 앞 항목에 이어 붙인다.
          const lastItem = items.at(-1);
          if (lastItem) lastItem.push(...parseInline(` ${current.trim()}`));
        } else {
          break;
        }
        i += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    const paragraph: InlinePart[][] = [];
    while (i < lines.length) {
      const current = lines[i] ?? '';
      if (current.trim() === '' || BULLET.test(current) || NUMBERED.test(current)) break;
      if (TABLE_ROW.test(current) && TABLE_RULE.test(lines[i + 1] ?? '')) break;
      paragraph.push(parseInline(current.trim()));
      i += 1;
    }
    blocks.push({ kind: 'paragraph', lines: paragraph });
  }
  return blocks;
}
