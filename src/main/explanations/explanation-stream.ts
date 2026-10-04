/** 구조화된 답변의 explanation 문자열만 점진적으로 읽는다. JSON 문법·다른 메시지는 노출하지 않는다. */
export class ExplanationStream {
  private raw = '';
  private position: number | null = null;
  private decoded = '';
  private ended = false;
  private invalid = false;

  get text(): string {
    // UTF-16 서로게이트 쌍이 다음 조각에 걸쳐 있으면 완성될 때까지 기다린다.
    return this.decoded.replace(/[\uD800-\uDBFF]$/, '');
  }

  append(delta: string): void {
    if (this.ended || this.invalid) return;
    this.raw += delta;
    if (this.position === null) {
      const header = /^\s*(?:```(?:json)?\s*)?\{\s*"explanation"\s*:\s*"/.exec(this.raw);
      if (!header) return;
      this.position = header[0].length;
    }
    while (this.position < this.raw.length) {
      const at = this.position;
      const char = this.raw[at]!;
      if (char === '"') {
        this.ended = true;
        return;
      }
      if (char === '\\') {
        const escaped = this.raw[at + 1];
        if (escaped === undefined) return;
        if (escaped === 'u') {
          if (at + 6 > this.raw.length) return;
          const digits = this.raw.slice(at + 2, at + 6);
          if (!/^[0-9a-f]{4}$/i.test(digits)) {
            this.invalid = true;
            return;
          }
          this.decoded += String.fromCharCode(parseInt(digits, 16));
          this.position += 6;
          continue;
        }
        const escapes: Record<string, string> = {
          '"': '"',
          '\\': '\\',
          '/': '/',
          b: '\b',
          f: '\f',
          n: '\n',
          r: '\r',
          t: '\t',
        };
        if (!Object.hasOwn(escapes, escaped)) {
          this.invalid = true;
          return;
        }
        this.decoded += escapes[escaped];
        this.position += 2;
      } else {
        if (char.charCodeAt(0) < 0x20) {
          this.invalid = true;
          return;
        }
        this.decoded += char;
        this.position++;
      }
    }
  }
}
