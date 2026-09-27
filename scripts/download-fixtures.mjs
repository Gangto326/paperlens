// 검증 논문 PDF를 fixtures/papers/에 받는다(`npm run fixtures:download`).
// PDF는 재배포하지 않으므로 커밋하지 않고, fixtures/papers.json의 url·sha256으로 같은 파일인지 확인한다.
// TEI(fixtures/tei/<id>.tei.xml)는 받을 수 없다 — GROBID 0.9.1을 띄운 뒤 `--tei`를 붙여 실행하면 만든다.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'fixtures/papers.json'), 'utf8'));
const withTei = process.argv.includes('--tei');
const GROBID = process.env.PAPERLENS_GROBID_URL ?? 'http://127.0.0.1:8070';
// src/main/parser/grobid-fulltext.ts의 요청 설정과 같아야 한다.
const TEI_COORDINATES = ['s', 'figure', 'formula', 'biblStruct', 'ref', 'persName'];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
let failed = false;

mkdirSync(resolve(root, 'fixtures/papers'), { recursive: true });
mkdirSync(resolve(root, 'fixtures/tei'), { recursive: true });

for (const paper of manifest.papers) {
  const pdfPath = resolve(root, 'fixtures/papers', `${paper.id}.pdf`);
  let bytes;
  if (existsSync(pdfPath)) {
    bytes = readFileSync(pdfPath);
  } else {
    console.log(`${paper.id}: ${paper.url} 받는 중`);
    const res = await fetch(paper.url);
    if (!res.ok) {
      console.error(`${paper.id}: 받기 실패 HTTP ${res.status}`);
      failed = true;
      continue;
    }
    bytes = Buffer.from(await res.arrayBuffer());
    writeFileSync(pdfPath, bytes);
  }
  const actual = sha256(bytes);
  if (actual !== paper.sha256) {
    // arXiv가 같은 버전의 PDF를 다시 만들면 바이트가 달라질 수 있다. 그때는 정답 표본을 다시 만들어야 한다.
    console.error(`${paper.id}: sha256 불일치\n  기대 ${paper.sha256}\n  실제 ${actual}`);
    failed = true;
    continue;
  }
  console.log(`${paper.id}: PDF 확인 (${paper.arxivVersion}, ${bytes.length} bytes)`);

  if (!withTei) continue;
  const teiPath = resolve(root, 'fixtures/tei', `${paper.id}.tei.xml`);
  if (existsSync(teiPath)) {
    console.log(`${paper.id}: TEI 있음`);
    continue;
  }
  const form = new FormData();
  form.append('input', new Blob([bytes], { type: 'application/pdf' }), `${paper.id}.pdf`);
  form.append('segmentSentences', '1');
  form.append('consolidateHeader', '0');
  form.append('consolidateCitations', '0');
  for (const c of TEI_COORDINATES) form.append('teiCoordinates', c);
  try {
    const res = await fetch(`${GROBID}/api/processFulltextDocument`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(teiPath, await res.text());
    console.log(`${paper.id}: TEI 생성`);
  } catch (err) {
    console.error(`${paper.id}: GROBID 요청 실패 (${GROBID}) ${String(err)}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
