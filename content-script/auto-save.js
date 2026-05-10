// This script is intentionally minimal.
// All download logic now lives in background/auto-save-handler.js
// which watches chrome.storage.onChanged directly.
// This file just logs confirmation that the content script loaded.
(function () {
  if (window.__summarizeAutoSaveLoaded) return;
  window.__summarizeAutoSaveLoaded = true;
  console.log('[AutoSave] content script loaded (storage watcher active in background)');
})();
