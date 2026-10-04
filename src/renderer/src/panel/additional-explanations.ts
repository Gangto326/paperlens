import type { TranslationSnapshot } from '@shared/ipc';
import {
  additionalKey,
  additionalSource,
  parseAdditionalTarget,
  type AdditionalExplanation,
  type AdditionalTarget,
} from '@shared/additional-explanation';

export type AdditionalControl = (target: AdditionalTarget) => HTMLElement;

/** 문장 이동으로 DOM이 바뀌어도 논문별 응답과 생성 상태를 유지한다. */
export class AdditionalExplanationControls {
  private sha: string | null = null;
  private snapshot: TranslationSnapshot | null = null;
  private readonly states = new Map<string, AdditionalExplanation>();
  private readonly folded = new Map<string, boolean>();
  constructor(private readonly error: (err: unknown) => void) {
    window.paperlens.onAdditionalExplanation((state) => this.accept(state));
  }
  setDocument(sha: string | null): void {
    this.sha = sha;
    this.snapshot = null;
    this.states.clear();
    this.folded.clear();
    if (sha) {
      void window.paperlens
        .readAdditionalExplanations(sha)
        .then((states) => {
          if (this.sha !== sha) return;
          for (const state of states) this.accept(state);
        })
        .catch((err: unknown) => {
          if (this.sha === sha) this.error(err);
        });
    }
  }
  setSnapshot(snapshot: TranslationSnapshot): void {
    if (snapshot.pdfSha256 === this.sha) this.snapshot = snapshot;
  }
  private accept(state: AdditionalExplanation): void {
    if (state.pdfSha256 !== this.sha) return;
    const key = additionalKey(state.target, state.source);
    const old = this.states.get(key);
    if (old && old.updatedAt > state.updatedAt) return;
    this.states.set(key, state);
    for (const root of document.querySelectorAll<HTMLElement>('.additional-explanation')) {
      const target = parseAdditionalTarget(JSON.parse(root.dataset['extraTarget']!));
      const source = this.snapshot ? additionalSource(this.snapshot, target) : null;
      if (source && additionalKey(target, source) === key) this.paint(root, target);
    }
  }
  create: AdditionalControl = (target) => {
    const root = document.createElement('div');
    root.className = 'additional-explanation';
    root.dataset['extraTarget'] = JSON.stringify(target);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy-button additional-button';
    const status = document.createElement('p');
    status.className = 'additional-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const answer = document.createElement('div');
    answer.className = 'additional-answer';
    answer.lang = 'ko';
    const result = document.createElement('details');
    result.className = 'additional-result';
    result.open = true;
    const summary = document.createElement('summary');
    summary.className = 'additional-summary';
    result.append(summary, answer);
    root.append(button, status, result);
    const createdSha = this.sha;
    const createdSource = this.snapshot ? additionalSource(this.snapshot, target) : null;
    if (createdSource) result.dataset['additionalKey'] = additionalKey(target, createdSource);
    result.addEventListener('toggle', () => {
      if (!result.isConnected || createdSha !== this.sha || !createdSource || summary.hidden)
        return;
      const key = additionalKey(target, createdSource);
      this.folded.set(key, !result.open);
      // 같은 개념이 문장과 논문 노트에 동시에 그려져 있어도 접힘 상태를 공유한다.
      for (const other of document.querySelectorAll<HTMLDetailsElement>('.additional-result')) {
        if (
          other !== result &&
          other.dataset['additionalKey'] === key &&
          other.open !== result.open
        )
          other.open = result.open;
      }
    });
    button.addEventListener('click', () => {
      if (!this.sha || !this.snapshot || button.disabled) return;
      const source = additionalSource(this.snapshot, target);
      if (!source) return;
      const sha = this.sha;
      const key = additionalKey(target, source);
      const old = this.states.get(key);
      const pending: AdditionalExplanation = {
        pdfSha256: sha,
        target,
        source,
        status: 'running',
        text: old?.text ?? null,
        message: old?.text ? '추가 설명을 저장하고 있습니다.' : 'AI에 설명을 요청하고 있습니다.',
        startedAt: Date.now(),
        updatedAt: 0,
      };
      this.states.set(key, pending);
      this.accept(pending);
      void window.paperlens
        .requestAdditionalExplanation(sha, target)
        .then((state) => this.accept(state))
        .catch(() => {
          if (this.sha !== sha) return;
          this.accept({
            ...pending,
            status: 'failed',
            updatedAt: Date.now(),
            message: '설명을 요청하지 못했습니다. 잠시 후 다시 시도해 주세요.',
          });
        });
    });
    this.paint(root, target);
    return root;
  };
  private paint(root: HTMLElement, target: AdditionalTarget): void {
    const source = this.snapshot ? additionalSource(this.snapshot, target) : null;
    const state = source ? this.states.get(additionalKey(target, source)) : undefined;
    const button = root.querySelector<HTMLButtonElement>('button')!;
    const status = root.querySelector<HTMLElement>('.additional-status')!;
    const answer = root.querySelector<HTMLElement>('.additional-answer')!;
    const running = state?.status === 'running';
    const result = root.querySelector<HTMLDetailsElement>('.additional-result')!;
    const summary = root.querySelector<HTMLElement>('.additional-summary')!;
    root.dataset['state'] = state?.status ?? 'idle';
    root.setAttribute('aria-busy', String(running));
    button.hidden = state?.status === 'complete';
    button.disabled = !source || running || state?.status === 'complete';
    button.textContent = running
      ? 'AI 설명 생성 중…'
      : state?.status === 'complete'
        ? 'AI 추가 설명 · 저장됨'
        : state?.status === 'failed'
          ? state.text
            ? '다시 저장'
            : '다시 시도'
          : 'AI 추가 설명 요청';
    status.hidden = !state || state.status === 'complete';
    if (status.textContent !== (state?.message ?? '')) status.textContent = state?.message ?? '';
    const text = state?.text ?? state?.previewText ?? '';
    result.hidden = !text;
    summary.hidden = !state?.text;
    summary.textContent =
      state?.status === 'complete' ? 'AI 추가 설명 · 저장됨' : 'AI 추가 설명 · 저장되지 않음';
    if (source) result.open = !state?.text || !this.folded.get(additionalKey(target, source));
    // 본문 문자열만 표시한다. 생성 중인 JSON 문법이나 HTML을 렌더링하지 않는다.
    if (answer.textContent !== text) answer.textContent = text;
  }
}
