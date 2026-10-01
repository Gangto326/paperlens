/**
 * PDF를 열지 못했을 때의 안내문(PLAN 10절 "PDF 손상·암호·텍스트 없음", COMMIT_PLAN C5.3).
 * pdf.js의 예외 이름으로 구분한다. 암호가 걸린 PDF는 열지 않는다(암호 입력은 지원하지 않는다).
 * 번역 시작 전에 멈추며, 이미 저장된 다른 문서는 영향을 받지 않는다.
 */
export function openErrorText(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);
  switch (name) {
    case 'PasswordException':
      return '이 PDF는 암호가 걸려 있습니다. 암호 입력은 지원하지 않으니 암호를 푼 사본을 여세요.';
    case 'InvalidPDFException':
      return `이 파일은 PDF로 읽을 수 없습니다(손상됐거나 PDF가 아닙니다): ${message}`;
    case 'MissingPDFException':
      return '파일을 찾을 수 없습니다. 옮겨지거나 지워졌을 수 있습니다.';
    case 'UnexpectedResponseException':
      return `파일을 읽는 중 문제가 생겼습니다: ${message}`;
    default:
      return `PDF를 열지 못했습니다: ${message}`;
  }
}
