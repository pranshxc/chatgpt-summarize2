(function () {
  'use strict';

  // ── Extension context guard ─────────────────────────────────────────────────
  function isCtxValid() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
    catch (e) { return false; }
  }

  // Auto-save summary via clipboard intercept + DOM scrape
  let lastSavedText = null;
  let autoClickDone = false;

  const _origWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
  navigator.clipboard.writeText = function (text) {
    const result = _origWriteText(text);
    if (text && text.length > 100) downloadText(text);
    return result;
  };

  function findCopyButton() {
    const app = document.getElementById('app');
    if (!app) return null;
    const buttons = Array.from(app.querySelectorAll('button'));
    const labeled = buttons.find(btn => [
      btn.getAttribute('aria-label') || '',
      btn.getAttribute('title') || '',
      btn.getAttribute('data-tooltip') || '',
      btn.innerText || '',
    ].join(' ').toLowerCase().includes('copy'));
    if (labeled) return labeled;
    const small = buttons.filter(btn => {
      const r = btn.getBoundingClientRect();
      return r.width > 0 && r.width < 60 && r.height < 60;
    }).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    for (let i = 0; i <= small.length - 3; i++) {
      const ra = small[i].getBoundingClientRect();
      const rb = small[i + 1].getBoundingClientRect();
      const rc = small[i + 2].getBoundingClientRect();
      if (
        Math.max(ra.top, rb.top, rc.top) - Math.min(ra.top, rb.top, rc.top) < 20 &&
        Math.max(ra.left, rb.left, rc.left) - Math.min(ra.left, rb.left, rc.left) < 160
      ) {
        return [small[i], small[i + 1], small[i + 2]]
          .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
      }
    }
    return null;
  }

  function getSummaryText() {
    const app = document.getElementById('app');
    if (!app) return null;
    let best = null, bestLen = 100;
    app.querySelectorAll('*').forEach(el => {
      if (el.childElementCount === 0) {
        const t = (el.innerText || '').trim();
        if (t.length > bestLen && !t.startsWith('#') && !t.startsWith('{')) { best = t; bestLen = t.length; }
      }
    });
    for (const sel of ['[class*="summary"]', '[class*="result"]', '[class*="output"]', '[class*="content"]', 'ul', 'ol', 'p']) {
      const el = app.querySelector(sel);
      if (el) { const t = (el.innerText || '').trim(); if (t.length > bestLen) { best = t; bestLen = t.length; } }
    }
    return best;
  }

  function tryScan() {
    if (autoClickDone) return;
    const btn = findCopyButton();
    if (!btn) return;
    autoClickDone = true;
    setTimeout(() => btn.click(), 200);
  }

  function checkAndSave() {
    tryScan();
    const text = getSummaryText();
    if (text && text !== lastSavedText) { lastSavedText = text; downloadText(text); }
  }

  function downloadText(text) {
    if (!text || text === lastSavedText) return;
    // Guard: do not call chrome APIs if extension context has been invalidated
    if (!isCtxValid()) {
      console.warn('[auto-save] Extension context invalidated — download suppressed.');
      return;
    }
    lastSavedText = text;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    try {
      chrome.downloads.download(
        { url, filename: 'summaries/summary-' + timestamp + '.txt', saveAs: false },
        () => URL.revokeObjectURL(url)
      );
    } catch (e) {
      console.warn('[auto-save] chrome.downloads.download failed:', e.message);
      URL.revokeObjectURL(url);
    }
  }

  let debounce = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounce);
    autoClickDone = false;
    debounce = setTimeout(checkAndSave, 1500);
  });

  function startObserving() {
    const app = document.getElementById('app');
    if (app) {
      observer.observe(app, { childList: true, subtree: true, characterData: true });
    } else {
      setTimeout(startObserving, 300);
    }
  }
  startObserving();

})();
