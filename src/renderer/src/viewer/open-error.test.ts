import { describe, expect, it } from 'vitest';
import { openErrorText } from './open-error';

const named = (name: string, message = 'm'): Error => Object.assign(new Error(message), { name });

describe('openErrorText', () => {
  it('암호·손상·없음을 구분하고 나머지는 원문 메시지를 붙인다', () => {
    expect(openErrorText(named('PasswordException'))).toContain('암호');
    expect(openErrorText(named('InvalidPDFException', 'bad xref'))).toContain('손상');
    expect(openErrorText(named('InvalidPDFException', 'bad xref'))).toContain('bad xref');
    expect(openErrorText(named('MissingPDFException'))).toContain('찾을 수 없습니다');
    expect(openErrorText(new Error('boom'))).toBe('PDF를 열지 못했습니다: boom');
    expect(openErrorText('x')).toBe('PDF를 열지 못했습니다: x');
  });
});
