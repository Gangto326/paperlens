import type { PaperLensApi } from './index';

declare global {
  interface Window {
    paperlens: PaperLensApi;
  }
}

export {};
