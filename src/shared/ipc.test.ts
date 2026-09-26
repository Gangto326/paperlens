import { describe, expect, it } from 'vitest';
import { IPC } from './ipc';

describe('IPC 채널 목록', () => {
  it('채널 이름은 중복되지 않는다', () => {
    const names = Object.values(IPC);
    expect(new Set(names).size).toBe(names.length);
  });
});
