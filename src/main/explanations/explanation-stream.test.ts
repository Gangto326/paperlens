import { expect, it } from 'vitest';
import { ExplanationStream } from './explanation-stream';

it('모든 조각 경계에서 JSON 문자열을 본문으로 복원한다', () => {
  const answer = '쉬운 설명입니다.\n\n"예시"와 \\경로, 탭\t, 이모지 🐧를 보여 줍니다.';
  const raw = JSON.stringify({ explanation: answer });
  for (let boundary = 0; boundary <= raw.length; boundary++) {
    const stream = new ExplanationStream();
    stream.append(raw.slice(0, boundary));
    expect(answer.startsWith(stream.text)).toBe(true);
    stream.append(raw.slice(boundary));
    expect(stream.text).toBe(answer);
  }
});

it('분리된 유니코드 이스케이프·서로게이트가 완성될 때만 표시한다', () => {
  const stream = new ExplanationStream();
  stream.append('{"explanation":"');
  for (const char of '\\uD83D') stream.append(char);
  expect(stream.text).toBe('');
  for (const char of '\\uDC27\\uD55C\\uAE00') stream.append(char);
  expect(stream.text).toBe('🐧한글');
  stream.append('"}');
  expect(stream.text).toBe('🐧한글');
});

it('코드 울타리·다른 필드·뒤따르는 JSON 문법을 표시하지 않는다', () => {
  const stream = new ExplanationStream();
  for (const char of '```json\n{"explanation":"답변","other":"secret"}\n```') stream.append(char);
  expect(stream.text).toBe('답변');
  for (const raw of [
    'private commentary',
    '{"other":"secret"}',
    '생각 중 {"explanation":"test"}',
  ]) {
    const ignored = new ExplanationStream();
    ignored.append(raw);
    expect(ignored.text).toBe('');
  }
});

it('잘못된 이스케이프 이후의 깨진 내용을 표시하지 않는다', () => {
  for (const invalid of ['\\q', '\\uZZZZ', '\n']) {
    const stream = new ExplanationStream();
    stream.append('{"explanation":"정상' + invalid + '깨진 내용"}');
    expect(stream.text).toBe('정상');
  }
});
