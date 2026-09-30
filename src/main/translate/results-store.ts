import { relative } from 'node:path';
import type { ConceptCard, ConceptSourceLink, TranslationSnapshot } from '@shared/ipc';
import type { ChunkDocument, ExtractionDocument, Reference, Source } from '@shared/schema';
import { CacheReadError, type PaperCacheStore } from '../cache/paper-cache-store';
import { planChunks, type ChunkerOptions } from '../chunk/chunker';
import { isSelfSource, paperIdentityOf } from '../research/self-source';

/**
 * 화면 표시용 번역 결과 읽기(COMMIT_PLAN C2.9). 캐시 파일만 읽는다. LLM을 부르지 않는다.
 * - 완료(complete) 청크의 결과만 돌려준다. 실패한 청크에 남은 부분 결과는 보여주지 않는다.
 * - 지금 세대에 완료가 없는 청크는 같은 추출본의 앞선 세대에서 같은 문장들의 완료 결과를 찾아 대신 보여 준다
 *   (COMMIT_PLAN C3.2). 컨텍스트나 지침이 바뀌어 새 세대를 만드는 동안 앞선 번역이 사라지지 않게 하려는 것이다.
 *   그 청크는 `previous`로 표시하고 진행률에는 세지 않는다. 새 세대의 완료가 생기면 그것으로 바뀐다.
 * - 파일 해시가 manifest와 다르거나 스키마가 맞지 않는 청크는 없는 것으로 본다.
 * - 청크 계획은 document.json에서 다시 계산한다. 아직 파일이 없는 청크는 pending이다.
 * - 개념 카드는 같은 세대의 context.json에서 읽는다. 읽지 못하면 카드 없이 번역만 돌려준다.
 * - 카드의 자료 링크는 같은 세대의 research.json에서 찾는다. 거기 없는 출처와 http(s)가 아닌 주소는 보이지 않는다.
 * - 번역 중인 논문 자체를 가리키는 출처는 보이지 않는다. 거르기 전에 만든 세대에도 들어 있다(Q7).
 */
const linksOf = (
  refs: readonly Reference[] | undefined,
  sources: ReadonlyMap<string, Source>,
  wanted: (source: Source) => boolean,
): ConceptSourceLink[] =>
  (refs ?? []).flatMap((ref) => {
    const source = sources.get(ref.sourceId);
    if (!source || !wanted(source) || !/^https?:\/\//i.test(source.finalUrl)) return [];
    return [
      {
        sourceId: source.id,
        url: source.finalUrl,
        title: source.title,
        publisher: source.publisher ?? null,
        kind: source.sourceType,
        language: source.language ?? null,
        supports: ref.supports,
      },
    ];
  });

export async function readTranslations(
  store: PaperCacheStore,
  pdfSha256: string,
  chunker?: Partial<ChunkerOptions>,
): Promise<TranslationSnapshot> {
  const manifest = await store.readManifest(pdfSha256);
  const empty: TranslationSnapshot = {
    pdfSha256,
    state: manifest.state,
    generationId: manifest.currentGenerationId ?? null,
    chunks: [],
    results: {},
  };
  const rev = manifest.currentExtractionRevision;
  if (!rev) return empty;
  const hashOf = (path: string): string | undefined =>
    manifest.files.find((f) => f.path === relative(store.paperDir(pdfSha256), path))?.sha256;

  let document: ExtractionDocument;
  const documentPath = store.extractionPath(pdfSha256, rev, 'document.json');
  try {
    document = await store.readJson('extractionDocument', documentPath, hashOf(documentPath));
  } catch (err) {
    if (err instanceof CacheReadError) return empty;
    throw err;
  }
  const plan = planChunks(document, chunker);
  const generationId = manifest.currentGenerationId ?? null;
  const snapshot: TranslationSnapshot = { ...empty, chunks: [], results: {}, concepts: {} };
  const concepts: Record<string, ConceptCard> = {};
  if (generationId !== null) {
    const sources = new Map<string, Source>();
    const identity = paperIdentityOf(document.paper);
    const researchPath = store.generationPath(pdfSha256, generationId, 'research.json');
    const researchSha = hashOf(researchPath);
    if (researchSha !== undefined) {
      try {
        const research = await store.readJson('researchDocument', researchPath, researchSha);
        for (const source of research.sources) {
          if (isSelfSource(identity, { url: source.finalUrl, title: source.title })) continue;
          sources.set(source.id, source);
        }
      } catch (err) {
        if (!(err instanceof CacheReadError)) throw err;
      }
    }
    const path = store.generationPath(pdfSha256, generationId, 'context.json');
    const sha = hashOf(path);
    if (sha !== undefined) {
      try {
        const context = await store.readJson('contextDocument', path, sha);
        for (const c of context.concepts) {
          const read = linksOf(c.refs, sources, (s) => s.fetchStatus === 'read');
          const further = linksOf(c.furtherRefs, sources, (s) => s.fetchStatus !== 'failed');
          concepts[c.id] = {
            id: c.id,
            name: c.name,
            nameKo: c.nameKo ?? null,
            definitionKo: c.definitionKo,
            whyItMatters: c.whyItMatters,
            exampleKo: c.exampleKo ?? null,
            prerequisiteConceptIds: c.prerequisiteConceptIds,
            sourced: c.researchStatus === 'researched' && read.length > 0,
            sources: read,
            further,
          };
        }
      } catch (err) {
        if (!(err instanceof CacheReadError)) throw err;
      }
    }
  }
  snapshot.concepts = concepts;
  // 앞선 세대는 새것부터 본다. 다른 추출본의 세대는 문장 id가 달라 쓰지 않는다.
  const earlier = manifest.generations
    .filter((g) => g.generationId !== generationId && g.extractionRevision === rev)
    .map((g) => g.generationId)
    .reverse();
  const readChunk = async (
    gen: string,
    chunk: (typeof plan.chunks)[number],
  ): Promise<ChunkDocument | null> => {
    const path = store.generationPath(pdfSha256, gen, `chunks/${chunk.id}.json`);
    const sha = hashOf(path);
    if (sha === undefined) return null;
    try {
      const saved = await store.readJson('chunkDocument', path, sha);
      const same =
        saved.targetSentenceIds.length === chunk.targetSentenceIds.length &&
        saved.targetSentenceIds.every((id, i) => id === chunk.targetSentenceIds[i]);
      return same ? saved : null;
    } catch (err) {
      if (!(err instanceof CacheReadError)) throw err;
      return null;
    }
  };
  const take = (chunkId: string, saved: ChunkDocument, previousGenerationId?: string): void => {
    for (const r of saved.results) {
      snapshot.results[r.id] = {
        ko: r.ko,
        note: r.note,
        explanation: r.explanation ?? null,
        // 앞선 세대의 개념 카드 id는 지금 세대의 카드가 아니다. 잇지 않는다.
        conceptIds: previousGenerationId
          ? []
          : r.conceptIds.filter((id) => concepts[id] !== undefined),
        warnings: r.warnings,
        chunkId,
        ...(previousGenerationId ? { previousGenerationId } : {}),
      };
    }
  };
  for (const chunk of plan.chunks) {
    let status: TranslationSnapshot['chunks'][number]['status'] = 'pending';
    const saved = generationId === null ? null : await readChunk(generationId, chunk);
    if (saved?.status === 'complete') {
      status = 'complete';
      take(chunk.id, saved);
    } else if (saved?.status === 'failed') {
      status = 'failed';
    }
    let previous = false;
    if (status !== 'complete') {
      for (const gen of earlier) {
        const old = await readChunk(gen, chunk);
        if (old?.status !== 'complete') continue;
        take(chunk.id, old, gen);
        previous = true;
        break;
      }
    }
    snapshot.chunks.push({
      id: chunk.id,
      status,
      sentenceIds: chunk.targetSentenceIds,
      ...(previous ? { previous: true } : {}),
    });
  }
  return snapshot;
}
