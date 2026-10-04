import type { PaperState } from './schema';

export type WorkPhase = 'context' | 'research' | 'cards' | 'translating' | 'finished';
export interface WorkProgress {
  pdfSha256: string;
  revision: number;
  running: boolean;
  startedAt: number;
  endedAt: number | null;
  lastActivityAt: number;
  phase: WorkPhase;
  state: PaperState | null;
  step: { done: number; total: number } | null;
  completed: number;
  failed: number;
  total: number;
  chunks: { id: string; index: number; state: 'pending' | 'running' | 'complete' | 'failed' }[];
  jobs: { id: string; label: string; status: string; startedAt: number }[];
  history: { at: number; text: string }[];
}
export interface PreparationResource {
  title: string;
  url: string;
  topic: string;
  reason: string;
  kind: 'video' | 'article';
  language: string;
  verified: 'viewed' | 'listed';
}
export interface Preparation {
  pdfSha256: string;
  status: 'idle' | 'searching' | 'ready' | 'unavailable';
  updatedAt: number;
  message: string;
  resources: PreparationResource[];
}
export interface ReadingWork {
  progress: WorkProgress | null;
  preparation: Preparation;
}
export type WorkUpdate =
  | { type: 'progress'; progress: WorkProgress }
  | { type: 'preparation'; preparation: Preparation }
  | { type: 'notification'; pdfSha256: string; message: string };
