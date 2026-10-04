import { setupDisclosures } from './disclosures';
import { openNextConcept } from './reading-keyboard';

const SEEN_KEY = 'paperlens-reading-tutorial-v1';
const STEPS = [
  [
    '문장을 클릭해 읽기',
    '원문을 클릭하면 선택한 문장에 형광펜이 표시되고, 오른쪽에 번역과 해설이 나타납니다.',
  ],
  [
    '좌우 방향키로 다음 문장 읽기',
    '←는 이전 문장, →는 다음 문장입니다. 원문 표시와 해설이 함께 바뀝니다. 아래에서 방향키를 눌러보세요.',
  ],
  [
    '위아래 방향키로 해설 읽기',
    '↑와 ↓로 오른쪽 해설을 스크롤합니다. 원문에서 마우스를 옮기지 않아도 됩니다.',
  ],
  [
    'Tab으로 개념 펼치기',
    'Tab을 누르면 개념이 하나씩 열리고, 아래에 있던 카드는 해설 영역의 위쪽으로 이동합니다. Enter로 다시 접을 수 있습니다.',
  ],
];
const EXAMPLES = [
  ['The model retrieves relevant documents.', '모델은 관련 문서를 검색합니다.'],
  ['The documents provide useful context.', '문서는 유용한 맥락을 제공합니다.'],
  ['The answer is generated using this context.', '이 맥락을 활용해 답변을 생성합니다.'],
];

export function setupTutorial(): void {
  const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const dialog = el<HTMLDialogElement>('reading-tutorial');
  const title = el('tutorial-title');
  const next = el<HTMLButtonElement>('tutorial-next');
  const back = el<HTMLButtonElement>('tutorial-back');
  let step = 0;
  let example = 0;
  let returnFocus: HTMLElement | null = null;
  setupDisclosures(el('tutorial-concepts'));

  const showExample = (): void => {
    el('tutorial-example-en').textContent = EXAMPLES[example]![0]!;
    el('tutorial-example-ko').textContent = EXAMPLES[example]![1]!;
    el('tutorial-example-position').textContent = `${example + 1} / ${EXAMPLES.length} 문장`;
    el<HTMLButtonElement>('tutorial-sentence-prev').disabled = example === 0;
    el<HTMLButtonElement>('tutorial-sentence-next').disabled = example === EXAMPLES.length - 1;
  };
  const moveExample = (direction: number): void => {
    example = Math.max(0, Math.min(EXAMPLES.length - 1, example + direction));
    showExample();
  };
  const showStep = (): void => {
    title.textContent = STEPS[step]![0]!;
    el('tutorial-description').textContent = STEPS[step]![1]!;
    el('tutorial-progress').textContent = `읽기 안내 · ${step + 1} / ${STEPS.length}`;
    dialog.querySelectorAll<HTMLElement>('[data-demo]').forEach((demo) => {
      demo.hidden = Number(demo.dataset['demo']) !== step;
    });
    back.disabled = step === 0;
    next.textContent = step === STEPS.length - 1 ? '읽기 시작' : '다음';
    title.focus({ preventScroll: true });
  };
  const open = (): void => {
    if (dialog.open) return;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    step = 0;
    example = 0;
    el('tutorial-translation').hidden = true;
    el('tutorial-sentence').classList.remove('selected');
    el('tutorial-scroll').scrollTop = 0;
    dialog.querySelectorAll<HTMLDetailsElement>('details').forEach((card) => {
      card.getAnimations().forEach((animation) => animation.finish());
      card.open = false;
    });
    showExample();
    dialog.showModal();
    showStep();
  };
  dialog.addEventListener('close', () => {
    try {
      localStorage.setItem(SEEN_KEY, 'seen');
    } catch {
      /* 저장 불가 시 다음 실행에도 안내한다. */
    }
    if (returnFocus?.isConnected && returnFocus !== document.body) returnFocus.focus();
    else el('panel-content').focus({ preventScroll: true });
  });
  el('btn-help').addEventListener('click', open);
  el('tutorial-close').addEventListener('click', () => dialog.close());
  next.addEventListener('click', () => {
    if (step === STEPS.length - 1) dialog.close();
    else {
      step++;
      showStep();
    }
  });
  back.addEventListener('click', () => {
    step--;
    showStep();
  });
  el('tutorial-sentence').addEventListener('click', () => {
    el('tutorial-sentence').classList.add('selected');
    el('tutorial-translation').hidden = false;
  });
  el('tutorial-sentence-prev').addEventListener('click', () => moveExample(-1));
  el('tutorial-sentence-next').addEventListener('click', () => moveExample(1));
  dialog.addEventListener('keydown', (event) => {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    if (step === 1 && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      moveExample(event.key === 'ArrowRight' ? 1 : -1);
    } else if (step === 2 && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      el('tutorial-scroll').scrollBy({
        top: event.key === 'ArrowDown' ? 64 : -64,
        behavior: 'instant',
      });
    } else if (step === 3 && event.key === 'Tab') {
      const target = event.target instanceof Element ? event.target : null;
      if (target === title || target?.closest('#tutorial-concepts')) {
        if (openNextConcept(el('tutorial-concepts'))) event.preventDefault();
      }
    }
  });
  try {
    if (localStorage.getItem(SEEN_KEY) === 'seen') return;
  } catch {
    /* 첫 안내를 우선한다. */
  }
  open();
}
