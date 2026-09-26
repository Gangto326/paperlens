import type { Page, TextItemRecord } from '@shared/schema';
import { pageInfoFromProxy } from '../viewer/page-info';
import type { PDFDocumentProxy } from '../viewer/pdfjs';

/**
 * 항목 ID·index 부여 규칙의 버전. 규칙이 바뀌면 올린다 (extraction revision에 반영).
 * v1: index = 페이지의 getTextContent().items 중 TextItem(str 보유)만 센 순번.
 *     TextMarkedContent(beginMarkedContent 등)는 건너뛰며 번호를 소비하지 않는다.
 *     이 순번은 PDF.js TextLayer의 textContentItemsStr 순서와 같다.
 */
export const TEXT_EXTRACTOR_VERSION = '1';

export interface CollectedText {
  pages: Page[];
  textItems: TextItemRecord[];
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
  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1);
    pages.push(pageInfoFromProxy(i, page));
    const content = await page.getTextContent();
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
      index++;
    }
    onProgress?.(i + 1, doc.numPages);
  }
  return { pages, textItems };
}
