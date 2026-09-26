/**
 * 테스트용 최소 PDF 생성기. 외부 라이브러리 없이 한 페이지에 Helvetica 글자 하나를 찍는다.
 * MediaBox·CropBox·Rotate·UserUnit을 지정할 수 있어 좌표 변환 검증에 쓴다. ASCII만 쓰므로
 * 문자열 길이 = 바이트 길이이고 xref 오프셋이 정확하다.
 */
export interface MinimalPdfOptions {
  mediaBox: readonly [number, number, number, number];
  cropBox?: readonly [number, number, number, number];
  rotate?: number;
  userUnit?: number;
  text?: string;
  /** 글자의 기준선 시작점(user space). */
  at?: readonly [number, number];
  fontSize?: number;
}

export function buildMinimalPdf(opts: MinimalPdfOptions): Uint8Array {
  const text = opts.text ?? 'Hello';
  const [tx, ty] = opts.at ?? [100, 600];
  const fontSize = opts.fontSize ?? 12;
  const content = `BT /F1 ${fontSize} Tf ${tx} ${ty} Td (${text}) Tj ET`;
  const pageEntries = [
    '/Type /Page',
    '/Parent 2 0 R',
    `/MediaBox [${opts.mediaBox.join(' ')}]`,
    opts.cropBox ? `/CropBox [${opts.cropBox.join(' ')}]` : '',
    opts.rotate !== undefined ? `/Rotate ${opts.rotate}` : '',
    opts.userUnit !== undefined ? `/UserUnit ${opts.userUnit}` : '',
    '/Contents 4 0 R',
    '/Resources << /Font << /F1 5 0 R >> >>',
  ].filter(Boolean);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< ${pageEntries.join(' ')} >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
