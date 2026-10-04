import type { LibraryPaper, OpenedPdf } from '@shared/ipc';

function stateText(paper: LibraryPaper): string {
  if (paper.running) return '번역 중';
  switch (paper.state) {
    case 'complete':
      return '번역 완료';
    case 'complete_with_gaps':
      return '일부 구간 확인 필요';
    case 'waiting_quota':
      return '한도 대기';
    case 'needs_login':
      return '로그인 필요';
    case 'failed':
      return '다시 시도 가능';
    default:
      return '이어서 번역 가능';
  }
}

export function setupLibrary(open: (paper: OpenedPdf) => Promise<void>): void {
  const dialog = document.getElementById('library-dialog') as HTMLDialogElement;
  const list = document.getElementById('library-list')!;
  const message = document.getElementById('library-message')!;
  document.getElementById('library-close')!.addEventListener('click', () => dialog.close());
  document.getElementById('btn-library')!.addEventListener('click', () => {
    dialog.showModal();
    list.replaceChildren();
    message.textContent = '저장된 논문을 불러오는 중…';
    void window.paperlens
      .listLibrary()
      .then((papers) => {
        message.textContent = papers.length
          ? `${papers.length}편의 논문 · 최근 작업 순`
          : '아직 번역한 논문이 없습니다. PDF를 열어 첫 논문을 추가하세요.';
        for (const paper of papers) {
          const row = document.createElement('li');
          const button = document.createElement('button');
          button.className = 'library-paper';
          button.disabled = !paper.available;
          const title = document.createElement('strong');
          title.textContent = paper.title;
          const name = document.createElement('span');
          name.className = 'library-filename';
          name.textContent = paper.fileName;
          const meta = document.createElement('span');
          meta.className = 'library-meta';
          const state = document.createElement('span');
          state.className = 'library-state';
          state.dataset['complete'] = String(paper.state === 'complete');
          state.textContent = stateText(paper);
          const date = document.createElement('time');
          date.dateTime = paper.updatedAt;
          date.textContent = new Date(paper.updatedAt).toLocaleDateString('ko-KR');
          meta.append(state, date);
          button.append(title, name, meta);
          button.addEventListener('click', () => {
            button.disabled = true;
            void window.paperlens
              .openLibraryPaper(paper.pdfSha256)
              .then(async (pdf) => {
                dialog.close();
                await open(pdf);
              })
              .catch((err: unknown) => {
                message.textContent = err instanceof Error ? err.message : String(err);
                if (!dialog.open) dialog.showModal();
              })
              .finally(() => {
                button.disabled = false;
              });
          });
          row.append(button);
          if (!paper.available) {
            const note = document.createElement('p');
            note.className = 'library-missing';
            note.textContent = '원본 위치가 바뀌었습니다. PDF 열기에서 같은 파일을 선택해 주세요.';
            row.append(note);
          }
          list.append(row);
        }
      })
      .catch((err: unknown) => {
        message.textContent = `목록을 불러오지 못했습니다: ${String(err)}`;
      });
  });
}
