/**
 * renderer 전체에서 단 하나의 pdfjs-dist 인스턴스를 사용한다 (보완점 6).
 * 추출·표시·좌표 변환이 모두 같은 버전·같은 API에서 나와야 매핑이 성립한다.
 */
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export const PDFJS_VERSION: string = pdfjs.version;
export { pdfjs };
export type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
