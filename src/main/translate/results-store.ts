import { relative } from 'node:path';
import type { ConceptCard, TranslationSnapshot } from '@shared/ipc';
import type { ExtractionDocument } from '@shared/schema';
import { CacheReadError, type PaperCacheStore } from '../cache/paper-cache-store';
import { planChunks, type ChunkerOptions } from '../chunk/chunker';

/**
 * 화면 표시용 번역 결과 읽기(COMMIT_PLAN C2.9). 캐시 파일만 읽는다. LLM을 부르지 않는다.
 * - 완료(complete) 청크의 결과만 돌려준다. 실패한 청크에 남은 부분 결과는 보여주지 않는다.
 * - 파일 해시가 manifest와 다르거나 스키마가 맞지 않는 청크는 없는 것으로 본다.
 * - 청크 계획은 document.json에서 다시 계산한다. 아직 파일이 없는 청크는 pending이다.
 * - 개념 카드는 같은 세대의 context.json에서 읽는다. 읽지 못하면 카드 없이 번역만 돌려준다.
 */
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
    const path = store.generationPath(pdfSha256, generationId, 'context.json');
    const sha = hashOf(path);
    if (sha !== undefined) {
      try {
        const context = await store.readJson('contextDocument', path, sha);
        for (const c of context.concepts) {
          concepts[c.id] = {
            id: c.id,
            name: c.name,
            nameKo: c.nameKo ?? null,
            definitionKo: c.definitionKo,
            whyItMatters: c.whyItMatters,
            exampleKo: c.exampleKo ?? null,
            prerequisiteConceptIds: c.prerequisiteConceptIds,
            sourced: c.researchStatus === 'researched' && c.refs.length > 0,
          };
        }
      } catch (err) {
        if (!(err instanceof CacheReadError)) throw err;
      }
    }
  }
  snapshot.concepts = concepts;
  for (const chunk of plan.chunks) {
    let status: TranslationSnapshot['chunks'][number]['status'] = 'pending';
    if (generationId !== null) {
      const path = store.generationPath(pdfSha256, generationId, `chunks/${chunk.id}.json`);
      const sha = hashOf(path);
      if (sha !== undefined) {
        try {
          const saved = await store.readJson('chunkDocument', path, sha);
          const same =
            saved.targetSentenceIds.length === chunk.targetSentenceIds.length &&
            saved.targetSentenceIds.every((id, i) => id === chunk.targetSentenceIds[i]);
          if (same && saved.status === 'complete') {
            status = 'complete';
            for (const r of saved.results) {
              snapshot.results[r.id] = {
                ko: r.ko,
                note: r.note,
                explanation: r.explanation ?? null,
                conceptIds: r.conceptIds.filter((id) => concepts[id] !== undefined),
                warnings: r.warnings,
                chunkId: chunk.id,
              };
            }
          } else if (same && saved.status === 'failed') {
            status = 'failed';
          }
        } catch (err) {
          if (!(err instanceof CacheReadError)) throw err;
        }
      }
    }
    snapshot.chunks.push({ id: chunk.id, status, sentenceIds: chunk.targetSentenceIds });
  }
  return snapshot;
}
