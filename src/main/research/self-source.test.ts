import { describe, expect, it } from 'vitest';
import { isSelfSource, paperIdentityOf } from './self-source';

const TITLE = 'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks';
const RAG = paperIdentityOf({
  title: TITLE,
  doi: null,
  fileName: '2005.11401.pdf',
  originalPath: null,
});

describe('paperIdentityOf', () => {
  it('파일 이름에서 arXiv 번호를 읽는다', () => {
    expect(RAG.arxivId).toBe('2005.11401');
    expect(
      paperIdentityOf({ title: null, doi: null, fileName: 'paper.pdf', originalPath: null }),
    ).toEqual({ title: null, doi: null, arxivId: null });
    expect(
      paperIdentityOf({
        title: ' ',
        doi: '10.1000/ABC.1',
        fileName: 'a.pdf',
        originalPath: '/x/1706.03762v7.pdf',
      }),
    ).toEqual({ title: null, doi: '10.1000/abc.1', arxivId: '1706.03762' });
  });
});

describe('isSelfSource', () => {
  it('실측에서 본 네 주소를 모두 같은 논문으로 본다', () => {
    const seen = [
      'https://proceedings.nips.cc/paper/2020/file/6b493230205f780e1bc26945df7481e5-Paper.pdf',
      'https://arxiv.org/pdf/2005.11401',
      'https://papers.neurips.cc/paper/2020/file/6b493230205f780e1bc26945df7481e5-Paper.pdf',
      'https://arxiv.org/html/2005.11401v4',
    ];
    for (const url of seen) expect(isSelfSource(RAG, { url, title: TITLE })).toBe(true);
  });

  it('제목이 달라도 주소에 arXiv 번호나 DOI가 있으면 같은 논문이다', () => {
    expect(
      isSelfSource(RAG, { url: 'https://huggingface.co/papers/2005.11401', title: 'Paper page' }),
    ).toBe(true);
    expect(isSelfSource(RAG, { url: 'https://arxiv.org/abs/2005.114012', title: '다른 글' })).toBe(
      false,
    );
    const withDoi = paperIdentityOf({
      title: null,
      doi: '10.1000/ABC.1',
      fileName: 'a.pdf',
      originalPath: null,
    });
    expect(isSelfSource(withDoi, { url: 'https://doi.org/10.1000%2Fabc.1', title: '' })).toBe(true);
  });

  it('제목 앞뒤의 번호와 사이트 이름은 떼고 비교한다', () => {
    const url = 'https://mirror.example/paper/1';
    expect(isSelfSource(RAG, { url, title: `[2005.11401] ${TITLE}` })).toBe(true);
    expect(isSelfSource(RAG, { url, title: `${TITLE} - arXiv` })).toBe(true);
    expect(isSelfSource(RAG, { url, title: `${TITLE.toUpperCase()} | NeurIPS` })).toBe(true);
  });

  it('논문을 다룬 다른 글과 다른 논문은 외부 자료로 남긴다', () => {
    const url = 'https://blog.example/rag';
    expect(isSelfSource(RAG, { url, title: `${TITLE} 논문 리뷰` })).toBe(false);
    expect(isSelfSource(RAG, { url, title: `[논문 리뷰] ${TITLE} 정리` })).toBe(false);
    expect(
      isSelfSource(RAG, {
        url: 'https://arxiv.org/abs/2004.04906',
        title: 'Dense Passage Retrieval for Open-Domain Question Answering',
      }),
    ).toBe(false);
  });

  it('짧은 제목과 모르는 논문에서는 가려내지 않는다', () => {
    const short = paperIdentityOf({
      title: 'BERT',
      doi: null,
      fileName: 'b.pdf',
      originalPath: null,
    });
    expect(isSelfSource(short, { url: 'https://example.org/bert', title: 'BERT' })).toBe(false);
    const unknown = paperIdentityOf({
      title: null,
      doi: null,
      fileName: 'p.pdf',
      originalPath: null,
    });
    expect(isSelfSource(unknown, { url: 'https://arxiv.org/abs/2005.11401', title: TITLE })).toBe(
      false,
    );
  });
});
