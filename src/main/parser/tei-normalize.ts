import { XMLParser } from 'fast-xml-parser';
import type {
  BibliographicItem,
  ExcludedBlock,
  ExcludedBlockType,
  Rect,
  Section,
  Sentence,
} from '@shared/schema/types';
import { sha256Hex } from '../cache/hash';
import { pageIndicesOf, parseGrobidCoords } from './tei-coords';

/**
 * GROBID TEI(processFulltextDocument, segmentSentences=1, teiCoordinates=s,figure,formula,biblStruct,ref,persName)를
 * 캐시 스키마의 Section/Sentence/ExcludedBlock/BibliographicItem으로 정규화한다.
 *
 * 관찰한 TEI 구조(0.9.1-crf, 샘플 3편):
 * - teiHeader/fileDesc: 제목·저자·날짜·idno. teiHeader/profileDesc/abstract/div/p/s: 초록 문장.
 * - text/body의 직계 자식은 div*, figure*, note[place=foot]* 순. div 안은 head?, p*, formula*가 섞여 나온다.
 * - p 안은 s만 있고, s 안의 하위 요소는 ref(type=bibr|figure|table|foot|url)만 관찰됐다.
 * - figure는 type="table"이면 표. head·label·figDesc(div/p/s)·graphic·table을 품는다.
 * - text/back: div[type=acknowledgement|funding|…]/div/head,p 와 div[type=references]/listBibl/biblStruct*.
 * 규칙이 바뀌면 TEI_NORMALIZER_VERSION을 올린다(extraction revision 입력).
 */
export const TEI_NORMALIZER_VERSION = '1';

export interface TeiMetadata {
  title: string | null;
  authors: string[];
  year: number | null;
  doi: string | null;
}

export interface TeiNormalization {
  metadata: TeiMetadata;
  sections: Section[];
  sentences: Sentence[];
  excludedBlocks: ExcludedBlock[];
  bibliography: BibliographicItem[];
  /** 문서 수준 경고(문장·블록 개별 경고는 각 객체의 warnings/reason에 있다). */
  warnings: string[];
}

export interface NormalizeTeiOptions {
  pdfSha256: string;
  extractionRevision: string;
}

// ---------- 최소 XML 트리 ----------

interface XElement {
  tag: string;
  attrs: Record<string, string>;
  children: XNode[];
}
interface XText {
  text: string;
}
type XNode = XElement | XText;

const isElement = (n: XNode): n is XElement => 'tag' in n;

function toTree(raw: unknown): XNode[] {
  if (!Array.isArray(raw)) return [];
  const out: XNode[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec['#text'] === 'string') {
      out.push({ text: rec['#text'] });
      continue;
    }
    const tag = Object.keys(rec).find((k) => k !== ':@');
    if (tag === undefined) continue;
    const attrsRaw = rec[':@'];
    const attrs: Record<string, string> = {};
    if (typeof attrsRaw === 'object' && attrsRaw !== null) {
      for (const [k, v] of Object.entries(attrsRaw as Record<string, unknown>)) {
        if (typeof v === 'string') attrs[k] = v;
        else if (typeof v === 'number' || typeof v === 'boolean') attrs[k] = String(v);
      }
    }
    out.push({ tag, attrs, children: toTree(rec[tag]) });
  }
  return out;
}

function parseXml(xml: string): XNode[] {
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '',
    removeNSPrefix: true,
    trimValues: false,
    parseTagValue: false,
    parseAttributeValue: false,
    alwaysCreateTextNode: true,
    ignoreDeclaration: true,
    ignorePiTags: true,
  });
  return toTree(parser.parse(xml) as unknown);
}

const childElements = (el: XElement, tag?: string): XElement[] =>
  el.children.filter(isElement).filter((c) => tag === undefined || c.tag === tag);
const firstChild = (el: XElement, tag: string): XElement | undefined => childElements(el, tag)[0];

/** 자손 텍스트를 순서대로 이어 붙인다(xml:space="preserve" 그대로). */
function textOf(node: XNode): string {
  if (!isElement(node)) return node.text;
  return node.children.map(textOf).join('');
}
const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

function descendants(el: XElement, tag: string, out: XElement[] = []): XElement[] {
  for (const c of childElements(el)) {
    if (c.tag === tag) out.push(c);
    descendants(c, tag, out);
  }
  return out;
}

function findPath(nodes: XNode[], path: string[]): XElement | undefined {
  let current: XNode[] = nodes;
  let found: XElement | undefined;
  for (const tag of path) {
    found = current.filter(isElement).find((e) => e.tag === tag);
    if (!found) return undefined;
    current = found.children;
  }
  return found;
}

// ---------- ID ----------

const shortHash = (...parts: string[]): string => sha256Hex(parts.join(':')).slice(0, 16);

// ---------- 문장 경계 검사 ----------

const TERMINAL_RE = /[.!?…]["'”’)\]]*\s*$/;
/** 약어로 끝나는 문장은 GROBID가 잘못 자른 경계일 가능성이 높다(PLAN 5.x, `Fig.`·`et al.`). */
const ABBREVIATION_END_RE =
  /\b(?:Fig|Figs|Eq|Eqs|et al|e\.g|i\.e|vs|cf|resp|Tab|Sec|Ref|Refs|No|approx|ca|al|Dr|Prof|Mr|Ms|Mrs|St|Jr|Inc|Ltd|Co|Corp|Vol|pp|Ch|Eds?)\.\s*$/;

export function classifySentenceText(text: string): {
  kind: Sentence['kind'];
  warnings: string[];
} {
  const t = text.trim();
  const warnings: string[] = [];
  let kind: Sentence['kind'] = 'sentence';
  if (t === '') {
    return { kind: 'fragment', warnings: ['empty_text'] };
  }
  if (!TERMINAL_RE.test(t)) {
    kind = 'fragment';
    warnings.push('boundary_no_terminal_punctuation');
  } else if (ABBREVIATION_END_RE.test(t)) {
    warnings.push('boundary_abbreviation_end');
  }
  const first = t.charAt(0);
  if (first !== first.toUpperCase() && /\p{L}/u.test(first)) {
    warnings.push('boundary_lowercase_start');
  }
  return { kind, warnings };
}

// ---------- 정규화기 ----------

interface Builder {
  opts: NormalizeTeiOptions;
  sections: Section[];
  sentences: Sentence[];
  excludedBlocks: ExcludedBlock[];
  warnings: string[];
  paragraphCounter: number;
  /** GROBID xml:id(b12) → 그 참고문헌을 인용한 문장 ID */
  citations: Map<string, Set<string>>;
  lastPage: number;
}

function newSection(b: Builder, title: string, parentId: string | null): Section {
  const order = b.sections.length;
  const section: Section = {
    id: `sec_${shortHash(b.opts.pdfSha256, b.opts.extractionRevision, 'section', String(order))}`,
    parentId,
    title,
    order,
    sentenceIds: [],
  };
  b.sections.push(section);
  return section;
}

function newParagraphId(b: Builder): string {
  const n = b.paragraphCounter++;
  return `p_${shortHash(b.opts.pdfSha256, b.opts.extractionRevision, 'paragraph', String(n))}`;
}

function addSentence(b: Builder, sEl: XElement, section: Section, paragraphId: string): void {
  const order = b.sentences.length;
  const id = `s_${shortHash(b.opts.pdfSha256, b.opts.extractionRevision, String(order))}`;
  const enRaw = textOf(sEl);
  const { rects, warnings: coordWarnings } = parseGrobidCoords(sEl.attrs['coords']);
  const { kind, warnings: boundaryWarnings } = classifySentenceText(enRaw);
  const warnings = [...coordWarnings, ...boundaryWarnings];

  const citationMarkers: string[] = [];
  for (const ref of descendants(sEl, 'ref')) {
    const type = ref.attrs['type'];
    if (type === 'bibr') {
      citationMarkers.push(collapse(textOf(ref)));
      const target = ref.attrs['target'];
      if (target?.startsWith('#')) {
        const key = target.slice(1);
        const set = b.citations.get(key) ?? new Set<string>();
        set.add(id);
        b.citations.set(key, set);
      }
    } else if (type === 'foot') {
      warnings.push('inline_footnote_marker');
    }
  }
  for (const c of childElements(sEl)) {
    if (c.tag !== 'ref') warnings.push(`unexpected_child:${c.tag}`);
  }

  const pages = pageIndicesOf(rects);
  const page = pages[0] ?? b.lastPage;
  if (pages.length > 0) b.lastPage = page;

  b.sentences.push({
    id,
    order,
    page,
    pages: pages.length > 0 ? pages : [page],
    sectionId: section.id,
    paragraphId,
    kind,
    enRaw,
    // 정규화 텍스트(C1.9)가 들어오기 전까지 원문과 같다.
    en: enRaw,
    sourceSpans: [],
    rects,
    mappingStatus: 'unmapped',
    mappingConfidence: null,
    equations: [],
    citationMarkers,
    warnings,
  });
  section.sentenceIds.push(id);
}

function addExcluded(
  b: Builder,
  type: ExcludedBlockType,
  rects: Rect[],
  rawText: string | null,
  reason: string,
): ExcludedBlock {
  const order = b.excludedBlocks.length;
  const block: ExcludedBlock = {
    id: `x_${shortHash(b.opts.pdfSha256, b.opts.extractionRevision, 'excluded', String(order))}`,
    type,
    pageIndices: pageIndicesOf(rects),
    rects,
    rawText,
    reason,
    confidence: null,
  };
  b.excludedBlocks.push(block);
  return block;
}

/** div의 head·p·formula를 문서 순서대로 처리한다. */
function walkDiv(b: Builder, div: XElement, parentId: string | null): void {
  const head = firstChild(div, 'head');
  const title = head ? collapse(textOf(head)) : '';
  const section = newSection(b, title, parentId);
  if (!head) b.warnings.push(`section_without_head:${section.id}`);

  for (const child of childElements(div)) {
    switch (child.tag) {
      case 'head':
        break;
      case 'p': {
        const paragraphId = newParagraphId(b);
        for (const s of childElements(child, 's')) addSentence(b, s, section, paragraphId);
        const stray = childElements(child).filter((c) => c.tag !== 's');
        for (const c of stray) b.warnings.push(`unexpected_in_p:${c.tag}:${section.id}`);
        break;
      }
      case 'formula': {
        const { rects, warnings } = parseGrobidCoords(child.attrs['coords']);
        addExcluded(
          b,
          'formula',
          rects,
          collapse(textOf(child)),
          `GROBID <formula>${warnings.length ? ` (${warnings.join(',')})` : ''}`,
        );
        break;
      }
      case 'note': {
        addNote(b, child);
        break;
      }
      case 'figure': {
        addFigure(b, child);
        break;
      }
      case 'div':
        // 관찰된 TEI에서는 본문 div가 중첩되지 않지만, back의 acknowledgement처럼 감싸는 div가 있다.
        walkDiv(b, child, section.id);
        break;
      default:
        b.warnings.push(`unexpected_in_div:${child.tag}:${section.id}`);
    }
  }
}

function addFigure(b: Builder, fig: XElement): void {
  const isTable = fig.attrs['type'] === 'table';
  const { rects, warnings } = parseGrobidCoords(fig.attrs['coords']);
  const head = firstChild(fig, 'head');
  const figDesc = firstChild(fig, 'figDesc');
  const label = fig.attrs['id'] ?? '';
  const rawParts = [head ? collapse(textOf(head)) : '', figDesc ? collapse(textOf(figDesc)) : ''];
  addExcluded(
    b,
    isTable ? 'table' : 'figure',
    rects,
    rawParts.filter((p) => p !== '').join(' ') || null,
    `GROBID <figure${isTable ? ' type="table"' : ''}> ${label}${warnings.length ? ` (${warnings.join(',')})` : ''}`,
  );
  if (figDesc) {
    const captionRects: Rect[] = [];
    for (const s of descendants(figDesc, 's'))
      captionRects.push(...parseGrobidCoords(s.attrs['coords']).rects);
    if (captionRects.length > 0) {
      addExcluded(
        b,
        'caption',
        captionRects,
        collapse(textOf(figDesc)),
        `GROBID <figDesc> of ${label}`,
      );
    }
  }
}

function addNote(b: Builder, note: XElement): void {
  const place = note.attrs['place'];
  const rects: Rect[] = [];
  for (const s of descendants(note, 's')) rects.push(...parseGrobidCoords(s.attrs['coords']).rects);
  const type: ExcludedBlockType = place === 'foot' ? 'footnote' : 'other';
  const n = note.attrs['n'];
  addExcluded(
    b,
    type,
    rects,
    collapse(textOf(note)),
    `GROBID <note${place ? ` place="${place}"` : ''}${n ? ` n="${n}"` : ''}>`,
  );
}

function parseYear(when: string | undefined): number | null {
  const m = when?.match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

function personNames(scope: XElement): string[] {
  const names: string[] = [];
  for (const author of childElements(scope, 'author')) {
    const pers = firstChild(author, 'persName');
    if (!pers) continue;
    const parts = childElements(pers)
      .filter((c) => c.tag === 'forename' || c.tag === 'surname')
      .map((c) => collapse(textOf(c)))
      .filter((s) => s !== '');
    if (parts.length > 0) names.push(parts.join(' '));
  }
  return names;
}

function mainTitle(scope: XElement): string | null {
  const titles = childElements(scope, 'title');
  const main = titles.find((t) => t.attrs['type'] === 'main') ?? titles[0];
  const text = main ? collapse(textOf(main)) : '';
  return text === '' ? null : text;
}

function idnoOf(scope: XElement, type: string): string | null {
  const idno = descendants(scope, 'idno').find((i) => i.attrs['type'] === type);
  const text = idno ? collapse(textOf(idno)) : '';
  return text === '' ? null : text;
}

function readBibl(b: Builder, bibl: XElement, index: number): BibliographicItem {
  const analytic = firstChild(bibl, 'analytic');
  const monogr = firstChild(bibl, 'monogr');
  const authors = [
    ...(analytic ? personNames(analytic) : []),
    ...(analytic && personNames(analytic).length > 0 ? [] : monogr ? personNames(monogr) : []),
  ];
  const title = (analytic && mainTitle(analytic)) ?? (monogr && mainTitle(monogr)) ?? null;
  const date = monogr ? descendants(monogr, 'date')[0] : undefined;
  const ptr = descendants(bibl, 'ptr')[0];
  const xmlId = bibl.attrs['id'];
  const id = `b_${shortHash(b.opts.pdfSha256, b.opts.extractionRevision, 'bib', String(index))}`;
  const citing = xmlId ? [...(b.citations.get(xmlId) ?? [])] : [];
  const { rects, warnings } = parseGrobidCoords(bibl.attrs['coords']);
  addExcluded(
    b,
    'bibliography',
    rects,
    collapse(textOf(bibl)),
    `GROBID <biblStruct> ${xmlId ?? `#${index}`}${warnings.length ? ` (${warnings.join(',')})` : ''}`,
  );
  return {
    id,
    rawText: collapse(textOf(bibl)),
    title,
    authors,
    year: parseYear(date?.attrs['when']),
    doi: idnoOf(bibl, 'DOI'),
    urlFromPdf: ptr?.attrs['target'] ?? null,
    citingSentenceIds: citing,
  };
}

export function normalizeTei(tei: string, opts: NormalizeTeiOptions): TeiNormalization {
  const root = parseXml(tei);
  const teiEl = root.filter(isElement).find((e) => e.tag === 'TEI');
  if (!teiEl) throw new Error('TEI 루트 요소가 없습니다');

  const b: Builder = {
    opts,
    sections: [],
    sentences: [],
    excludedBlocks: [],
    warnings: [],
    paragraphCounter: 0,
    citations: new Map(),
    lastPage: 0,
  };

  // 메타데이터
  const header = firstChild(teiEl, 'teiHeader');
  const sourceBibl = header
    ? findPath(header.children, ['fileDesc', 'sourceDesc', 'biblStruct'])
    : undefined;
  const analytic = sourceBibl ? firstChild(sourceBibl, 'analytic') : undefined;
  const monogr = sourceBibl ? firstChild(sourceBibl, 'monogr') : undefined;
  const titleStmt = header ? findPath(header.children, ['fileDesc', 'titleStmt']) : undefined;
  const publicationDate = header
    ? findPath(header.children, ['fileDesc', 'publicationStmt', 'date'])
    : undefined;
  const metadata: TeiMetadata = {
    title: (titleStmt && mainTitle(titleStmt)) ?? (analytic && mainTitle(analytic)) ?? null,
    authors: analytic ? personNames(analytic) : monogr ? personNames(monogr) : [],
    year: parseYear(
      publicationDate?.attrs['when'] ??
        (monogr ? descendants(monogr, 'date')[0]?.attrs['when'] : undefined),
    ),
    doi: sourceBibl ? idnoOf(sourceBibl, 'DOI') : null,
  };

  // 초록: 섹션 "Abstract"
  const abstract = header ? findPath(header.children, ['profileDesc', 'abstract']) : undefined;
  if (abstract) {
    const abstractSection = newSection(b, 'Abstract', null);
    for (const p of descendants(abstract, 'p')) {
      const paragraphId = newParagraphId(b);
      for (const s of childElements(p, 's')) addSentence(b, s, abstractSection, paragraphId);
    }
    if (abstractSection.sentenceIds.length === 0) b.warnings.push('abstract_empty');
  } else {
    b.warnings.push('abstract_missing');
  }

  // 본문
  const body = findPath(teiEl.children, ['text', 'body']);
  if (!body) {
    b.warnings.push('body_missing');
  } else {
    const numbered = new Map<string, string>(); // head n → section id (parentId 추정용)
    for (const child of childElements(body)) {
      switch (child.tag) {
        case 'div': {
          const n = firstChild(child, 'head')?.attrs['n']?.replace(/\.$/, '');
          const parentN = n?.includes('.') ? n.slice(0, n.lastIndexOf('.')) : undefined;
          const parentId = parentN ? (numbered.get(parentN) ?? null) : null;
          const before = b.sections.length;
          walkDiv(b, child, parentId);
          const created = b.sections[before];
          if (n && created) numbered.set(n, created.id);
          break;
        }
        case 'figure':
          addFigure(b, child);
          break;
        case 'note':
          addNote(b, child);
          break;
        case 'formula': {
          const { rects } = parseGrobidCoords(child.attrs['coords']);
          addExcluded(b, 'formula', rects, collapse(textOf(child)), 'GROBID <formula> (body 직계)');
          break;
        }
        default:
          b.warnings.push(`unexpected_in_body:${child.tag}`);
      }
    }
  }

  // back: 감사의 글 등은 섹션으로, 참고문헌은 bibliography로
  const bibliography: BibliographicItem[] = [];
  const back = findPath(teiEl.children, ['text', 'back']);
  if (back) {
    for (const div of childElements(back, 'div')) {
      const type = div.attrs['type'] ?? '';
      if (type === 'references') {
        const items = descendants(div, 'biblStruct');
        items.forEach((bibl, i) => bibliography.push(readBibl(b, bibl, i)));
        continue;
      }
      // acknowledgement/funding/annex: 안쪽 div마다 섹션. 감싸는 div에 head가 없으면 섹션을 만들지 않는다.
      const inner = childElements(div, 'div');
      if (inner.length > 0 && !firstChild(div, 'head')) {
        for (const d of inner) walkDiv(b, d, null);
      } else {
        walkDiv(b, div, null);
      }
    }
  }

  // 본문에서 참고한 target이 참고문헌에 없으면 경고
  const bibIds = new Set(
    back
      ? descendants(back, 'biblStruct')
          .map((x) => x.attrs['id'])
          .filter((v) => v !== undefined)
      : [],
  );
  for (const key of b.citations.keys()) {
    if (!bibIds.has(key)) b.warnings.push(`citation_target_missing:${key}`);
  }

  return {
    metadata,
    sections: b.sections,
    sentences: b.sentences,
    excludedBlocks: b.excludedBlocks,
    bibliography,
    warnings: b.warnings,
  };
}
