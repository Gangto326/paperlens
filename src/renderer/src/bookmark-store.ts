/** 논문 해시별로 저장한다. 원문도 보관해 재분석 후 다른 문장으로 잘못 이동하지 않게 한다. */
export interface Bookmark {
  id: string;
  en: string;
  page: number;
}

export function bookmarkKey(pdfSha256: string): string {
  return `paperlens-bookmarks-v1:${pdfSha256}`;
}

export function decodeBookmarks(raw: string | null): Bookmark[] {
  if (raw === null) return [];
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error('책갈피 데이터 형식이 올바르지 않습니다.');
  const result = new Map<string, Bookmark>();
  for (const item of data as unknown[]) {
    if (
      !item ||
      typeof item !== 'object' ||
      !('id' in item) ||
      typeof item.id !== 'string' ||
      !item.id ||
      !('en' in item) ||
      typeof item.en !== 'string' ||
      !('page' in item) ||
      typeof item.page !== 'number' ||
      !Number.isInteger(item.page) ||
      item.page < 0
    )
      throw new Error('책갈피 데이터 형식이 올바르지 않습니다.');
    result.set(item.id, { id: item.id, en: item.en, page: item.page });
  }
  return [...result.values()];
}
