import type { FontRecord, Page, SourceMapDocument, TextItemRecord } from '@shared/schema';
import { SCHEMA_VERSION } from '@shared/schema';

/**
 * document.json 조립 테스트용 합성 논문. 1쪽(612×792), 본문 문단 2개·문장 5개(하나는 없는 2쪽에 좌표), 그림 1, 참고문헌 1.
 * 텍스트 항목은 문장 사각형과 정확히 겹치게 놓고, 3번째 문장에는 수학 글꼴(CMMI/CMSY) 항목 "x ∈ R"을 둔다.
 * 4번째 문장의 항목을 페이지 첫 항목(index 0)으로 두어 읽기 순서 경고(PLAN 5.2)가 나게 한다.
 */
export const TINY_SHA = 'b'.repeat(64);

export const TINY_TEI = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
<teiHeader><fileDesc><titleStmt><title level="a" type="main">Tiny Paper</title></titleStmt>
<publicationStmt><date type="published" when="2024-01-01">2024</date></publicationStmt>
<sourceDesc><biblStruct><analytic><author><persName><forename type="first">Ada</forename><surname>Lovelace</surname></persName></author></analytic><idno type="DOI">10.1000/tiny</idno></biblStruct></sourceDesc></fileDesc></teiHeader>
<text xml:lang="en"><body>
<div><head n="1">Introduction</head>
<p><s coords="1,100.00,100.00,200.00,10.00">First sentence of the paper.</s><s coords="1,100.00,112.00,200.00,10.00">Second sentence follows it.</s></p>
<p><s coords="1,100.00,130.00,200.00,10.00">We define x ∈ R here.</s><s coords="1,100.00,142.00,200.00,10.00">Fourth sentence is last.</s><s coords="2,100.00,100.00,200.00,10.00">Fifth on a missing page.</s></p>
</div>
<figure xml:id="fig_0" coords="1,100.00,300.00,200.00,100.00"><head>Figure 1</head><figDesc>A figure.</figDesc></figure>
</body>
<back><div type="references"><listBibl><biblStruct coords="1,100.00,500.00,200.00,10.00"><analytic><title level="a" type="main">Ref title</title></analytic><monogr><imprint><date when="2020"/></imprint></monogr></biblStruct></listBibl></div></back>
</text></TEI>
`;

export const TINY_PAGE_HEIGHT = 792;

export function tinyPages(): Page[] {
  return [
    {
      pageIndex: 0,
      pdfPageNumber: 1,
      width: 612,
      height: TINY_PAGE_HEIGHT,
      rotation: 0,
      userUnit: 1,
      mediaBox: [0, 0, 612, TINY_PAGE_HEIGHT],
      cropBox: [0, 0, 612, TINY_PAGE_HEIGHT],
      coordinateSpace: 'pdf_user_space',
      textQuality: 'ok',
      warnings: [],
    },
  ];
}

export function tinyFonts(): FontRecord[] {
  return [
    { id: 'f_text', name: 'ABCDEF+Times-Roman', family: 'serif' },
    { id: 'f_math', name: 'CMMI10', family: 'serif' },
    { id: 'f_sym', name: 'CMSY10', family: 'serif' },
  ];
}

/** GROBID 사각형(top-left y, 높이 h)에 놓인 항목. 기준선 = 792 − (yTop + h). */
function item(
  index: number,
  str: string,
  x: number,
  yTop: number,
  width: number,
  fontName = 'f_text',
): TextItemRecord {
  const h = 10;
  return {
    id: `t_0_${index}`,
    pageIndex: 0,
    index,
    str,
    transform: [h, 0, 0, h, x, TINY_PAGE_HEIGHT - (yTop + h)],
    width,
    height: h,
    fontName,
    dir: 'ltr',
    hasEOL: false,
  };
}

export function tinyItems(): TextItemRecord[] {
  return [
    item(0, 'Fourth sentence is last.', 100, 142, 200),
    item(1, 'First sentence of the paper.', 100, 100, 200),
    item(2, 'Second sentence follows it.', 100, 112, 200),
    item(3, 'We define ', 100, 130, 50),
    item(4, 'x', 150, 130, 8, 'f_math'),
    item(5, ' ∈ ', 160, 130, 15, 'f_sym'),
    item(6, 'R', 175, 130, 8, 'f_math'),
    item(7, ' here.', 185, 130, 30),
  ];
}

export function tinySourceMap(extractionRevision = 'rtiny'): SourceMapDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    pdfSha256: TINY_SHA,
    extractionRevision,
    pdfjsVersion: '6.3.289',
    textItems: tinyItems(),
    fonts: tinyFonts(),
    normalizationMaps: [],
  };
}
