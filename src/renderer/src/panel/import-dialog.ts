/** 한 번의 선택으로 분석부터 번역까지 이어간다. Escape도 '아니오'와 같다. */
export function confirmTranslation(fileName: string): Promise<boolean> {
  const dialog = document.getElementById('import-dialog') as HTMLDialogElement;
  document.getElementById('import-file')!.textContent = fileName;
  dialog.returnValue = 'no';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes'), { once: true });
    dialog.showModal();
  });
}
