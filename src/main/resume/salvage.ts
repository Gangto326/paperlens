/**
 * 끊긴 출력에서 온전한 항목 건지기(COMMIT_PLAN M3 P2).
 * 모델의 출력은 `{"kind":"results","results":[{…},{…},{…` 처럼 배열 도중에 끊길 수 있다.
 * 맨 바깥 객체에서 이름이 `key`인 배열을 찾아, 닫는 괄호까지 온 항목만 돌려준다. 끊긴 마지막 항목은 버린다.
 * 출력이 끊기지 않았으면 배열의 모든 항목이 나온다.
 * 여기서는 JSON으로 읽히는지만 본다. 항목의 모양과 내용은 쓰는 쪽이 검증한다.
 */

/** `from`에서 시작하는 글자열(`"`로 시작)의 끝 다음 위치. 닫히지 않았으면 -1 */
const stringEnd = (text: string, from: number): number => {
  for (let i = from + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') i += 1;
    else if (ch === '"') return i + 1;
  }
  return -1;
};

/** `from`에서 시작하는 객체나 배열의 끝 다음 위치. 닫히지 않았으면 -1 */
const containerEnd = (text: string, from: number): number => {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      const end = stringEnd(text, i);
      if (end < 0) return -1;
      i = end - 1;
    } else if (ch === '{' || ch === '[') {
      depth += 1;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
};

const skipSpace = (text: string, from: number): number => {
  let i = from;
  while (i < text.length && /\s/.test(text[i] ?? '')) i += 1;
  return i;
};

/** 맨 바깥 객체의 `key` 배열이 시작하는 자리(`[` 다음). 없으면 -1 */
const arrayStart = (text: string, key: string): number => {
  let i = skipSpace(text, 0);
  if (text[i] !== '{') return -1;
  i += 1;
  for (;;) {
    i = skipSpace(text, i);
    if (text[i] === ',') {
      i += 1;
      continue;
    }
    if (text[i] !== '"') return -1;
    const nameEnd = stringEnd(text, i);
    if (nameEnd < 0) return -1;
    let name: unknown;
    try {
      name = JSON.parse(text.slice(i, nameEnd));
    } catch {
      return -1;
    }
    i = skipSpace(text, nameEnd);
    if (text[i] !== ':') return -1;
    i = skipSpace(text, i + 1);
    if (name === key) return text[i] === '[' ? i + 1 : -1;
    // 다른 이름의 값은 건너뛴다.
    const ch = text[i];
    if (ch === '"') i = stringEnd(text, i);
    else if (ch === '{' || ch === '[') i = containerEnd(text, i);
    else {
      while (i < text.length && !/[,}\s]/.test(text[i] ?? '')) i += 1;
    }
    if (i < 0) return -1;
  }
};

export function salvageArrayItems(text: string, key: string): unknown[] {
  const items: unknown[] = [];
  let i = arrayStart(text, key);
  if (i < 0) return items;
  for (;;) {
    i = skipSpace(text, i);
    if (text[i] === ',') {
      i += 1;
      continue;
    }
    if (text[i] !== '{') return items;
    const end = containerEnd(text, i);
    if (end < 0) return items;
    try {
      items.push(JSON.parse(text.slice(i, end)));
    } catch {
      return items;
    }
    i = end;
  }
}
