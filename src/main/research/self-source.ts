import type { Paper } from '@shared/schema';

/**
 * 번역 중인 논문 자체를 가리키는 출처 가려내기(docs/quality-backlog.md Q7).
 * 독자는 이미 그 논문을 읽고 있다. 카드의 자료는 논문 밖에서 교차 확인한 것이어야 한다.
 * - arXiv 번호나 DOI가 주소에 들어 있으면 같은 논문이다. 미러와 초록 페이지도 포함한다.
 * - 제목이 같으면 같은 논문이다. 앞의 "[번호]"와 뒤의 사이트 이름은 떼고 비교한다.
 *   제목에 다른 말이 붙은 글(논문 리뷰, 해설)은 외부 자료로 남긴다.
 * - 제목도 번호도 모르는 논문에서는 아무것도 가려내지 않는다.
 */
export interface PaperIdentity {
  title: string | null;
  doi: string | null;
  arxivId: string | null;
}

/** 짧은 제목은 우연히 같을 수 있어 비교하지 않는다. */
const MIN_TITLE_LENGTH = 16;

const ARXIV_ID = /(?<!\d)(\d{4}\.\d{4,5})(?!\d)/;

const blankToNull = (text: string | null | undefined): string | null => {
  const trimmed = (text ?? '').trim();
  return trimmed === '' ? null : trimmed;
};

export function paperIdentityOf(
  paper: Pick<Paper, 'title' | 'doi' | 'fileName' | 'originalPath'>,
): PaperIdentity {
  const named = ARXIV_ID.exec(paper.fileName) ?? ARXIV_ID.exec(paper.originalPath ?? '');
  return {
    title: blankToNull(paper.title),
    doi: blankToNull(paper.doi)?.toLowerCase() ?? null,
    arxivId: named?.[1] ?? null,
  };
}

const fold = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

/** 앞의 "[2005.11401]"과 뒤의 " - arXiv", " | NeurIPS" 같은 사이트 이름을 뗀다. */
const stripSiteParts = (title: string): string =>
  title
    .trim()
    .replace(/^\[[^\]]*\]\s*/, '')
    .replace(/\s+[-–—|·]\s+[A-Za-z0-9 .]{1,30}$/, '');

const decoded = (url: string): string => {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
};

export function isSelfSource(
  identity: PaperIdentity,
  source: { url: string; title: string },
): boolean {
  const url = decoded(source.url).toLowerCase();
  if (identity.arxivId !== null) {
    const found = new RegExp(`(?<!\\d)${identity.arxivId.replace('.', '\\.')}(?!\\d)`).test(url);
    if (found) return true;
  }
  if (identity.doi !== null && url.includes(identity.doi)) return true;
  if (identity.title !== null) {
    const wanted = fold(identity.title);
    if (wanted.length >= MIN_TITLE_LENGTH) {
      if (fold(source.title) === wanted || fold(stripSiteParts(source.title)) === wanted) {
        return true;
      }
    }
  }
  return false;
}
