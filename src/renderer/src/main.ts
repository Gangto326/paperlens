const statusEl = document.getElementById('status');

async function boot(): Promise<void> {
  const info = await window.paperlens.getAppInfo();
  if (statusEl) {
    statusEl.textContent = `PaperLens ${info.appVersion} · Electron ${info.electronVersion} · ${info.platform}`;
  }
}

void boot().catch((err: unknown) => {
  if (statusEl) statusEl.textContent = `초기화 실패: ${String(err)}`;
});
