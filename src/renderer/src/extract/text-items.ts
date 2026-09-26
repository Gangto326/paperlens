import type { FontRecord, Page, TextItemRecord } from '@shared/schema';
import { pageInfoFromProxy } from '../viewer/page-info';
import type { PDFDocumentProxy, PDFPageProxy } from '../viewer/pdfjs';

/**
 * 항목 ID·index 부여 규칙의 버전. 규칙이 바뀌면 올린다 (extraction revision에 반영).
 * v1: index = 페이지의 getTextContent().items 중 TextItem(str 보유)만 센 순번.
 *     TextMarkedContent(beginMarkedContent 등)는 건너뛰며 번호를 소비하지 않는다.
 *     이 순번은 PDF.js TextLayer의 textContentItemsStr 순서와 같다.
 * v2: 글꼴 표(fonts)를 함께 모은다. getTextContent의 styles는 계열(serif 등)만 주므로 실제 이름(BaseFont)은
 *     getOperatorList()로 글꼴을 로드한 뒤 commonObjs에서 읽는다(인라인 수식 검출 C1.13의 수학 글꼴 판별용).
 *     페이지 오퍼레이터 목록은 읽은 뒤 cleanup()으로 돌려준다(글꼴은 문서 단위 commonObjs에 남는다).
 */
export const TEXT_EXTRACTOR_VERSION = '2';

export interface CollectedText {
  pages: Page[];
  textItems: TextItemRecord[];
  fonts: FontRecord[];
}

/** commonObjs에 실린 글꼴 객체의 이름. 로드 실패·미등록이면 빈 문자열. */
function fontBaseName(page: PDFPageProxy, fontName: string): string {
  if (!page.commonObjs.has(fontName)) return '';
  const font: unknown = page.commonObjs.get(fontName);
  if (typeof font !== 'object' || font === null) return '';
  const name = (font as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

/**
 * 전 페이지의 텍스트 항목을 화면 텍스트 레이어와 같은 PDF.js 인스턴스·같은 기본 옵션의
 * getTextContent()로 모은다(보완점 6). 항목은 가공하지 않고 원본 그대로 보존한다.
 */
export async function collectTextItems(
  doc: PDFDocumentProxy,
  onProgress?: (done: number, total: number) => void,
): Promise<CollectedText> {
  const pages: Page[] = [];
  const textItems: TextItemRecord[] = [];
  const fonts = new Map<string, FontRecord>();
  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1);
    pages.push(pageInfoFromProxy(i, page));
    // 글꼴을 commonObjs에 싣기 위해 오퍼레이터 목록을 먼저 만든다(렌더링은 하지 않는다).
    await page.getOperatorList();
    const content = await page.getTextContent();
    for (const [fontName, style] of Object.entries(content.styles)) {
      if (fonts.has(fontName)) continue;
      fonts.set(fontName, {
        id: fontName,
        name: fontBaseName(page, fontName),
        family: typeof style.fontFamily === 'string' ? style.fontFamily : '',
      });
    }
    let index = 0;
    for (const item of content.items) {
      if (!('str' in item)) continue;
      if (item.transform.length !== 6) {
        throw new Error(`page ${i} item ${index}: transform 길이 ${item.transform.length}`);
      }
      textItems.push({
        id: `t_${i}_${index}`,
        pageIndex: i,
        index,
        str: item.str,
        transform: item.transform as [number, number, number, number, number, number],
        width: item.width,
        height: item.height,
        fontName: item.fontName,
        dir: item.dir,
        hasEOL: item.hasEOL,
      });
      if (!fonts.has(item.fontName)) {
        fonts.set(item.fontName, {
          id: item.fontName,
          name: fontBaseName(page, item.fontName),
          family: '',
        });
      }
      index++;
    }
    // 오퍼레이터 목록·페이지 객체를 돌려준다. 렌더링 중이면 false를 돌려주고 아무것도 지우지 않는다.
    page.cleanup();
    onProgress?.(i + 1, doc.numPages);
  }
  return { pages, textItems, fonts: [...fonts.values()] };
}
