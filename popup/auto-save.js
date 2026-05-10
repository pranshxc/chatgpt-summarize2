(function () {
  let lastSavedText = null;
  let autoClickDone = false;

  // ── Find the copy button and click it ─────────────────────────────────────────────
  // The popup renders the summary + copy/rewrite/info buttons inside #app.
  // We are NOW inside the popup page so we can see everything in #app directly.

  // Intercept clipboard so we get the exact text the copy button copies
  const _origWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
  navigator.clipboard.writeText = function (text) {
    const result = _origWriteText(text);
    console.log('[AutoSave] clipboard intercepted, length:', text && text.length);
    if (text && text.length > 100) {
      downloadText(text);
    }
    return result;
  };

  function findCopyButton() {
    const app = document.getElementById('app');
    if (!app) return null;

    // Search all buttons in #app
    const buttons = Array.from(app.querySelectorAll('button'));
    console.log('[AutoSave] buttons in #app:', buttons.length);

    // Try label-based match first
    const labeled = buttons.find(btn => {
      const label = [
        btn.getAttribute('aria-label') || '',
        btn.getAttribute('title') || '',
        btn.getAttribute('data-tooltip') || '',
        btn.innerText || '',
      ].join(' ').toLowerCase();
      return label.includes('copy');
    });
    if (labeled) return labeled;

    // Fallback: find tightly grouped small buttons (the 3-button action row)
    // Sort by position and find a row of 3 within 150px x-spread, 20px y-spread
    const small = buttons.filter(btn => {
      const r = btn.getBoundingClientRect();
      return r.width > 0 && r.width < 60 && r.height < 60;
    });

    const sorted = [...small].sort((a, b) =>
      a.getBoundingClientRect().top - b.getBoundingClientRect().top
    );

    for (let i = 0; i <= sorted.length - 3; i++) {
      const ra = sorted[i].getBoundingClientRect();
      const rb = sorted[i+1].getBoundingClientRect();
      const rc = sorted[i+2].getBoundingClientRect();
      const ySpread = Math.max(ra.top, rb.top, rc.top) - Math.min(ra.top, rb.top, rc.top);
      const xSpread = Math.max(ra.left, rb.left, rc.left) - Math.min(ra.left, rb.left, rc.left);
      if (ySpread < 20 && xSpread < 160) {
        // Return leftmost = copy button
        return [sorted[i], sorted[i+1], sorted[i+2]]
          .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
      }
    }
    return null;
  }

  function tryScan() {
    if (autoClickDone) return;
    const btn = findCopyButton();
    if (!btn) return;
    autoClickDone = true;
    console.log('[AutoSave] clicking copy button');
    setTimeout(() => btn.click(), 200);
  }

  // ── Fallback: direct text scrape from #app ─────────────────────────────────────────
  function getSummaryText() {
    const app = document.getElementById('app');
    if (!app) return null;
    // Find the largest leaf text block in #app
    let best = null;
    let bestLen = 100;
    app.querySelectorAll('*').forEach(el => {
      if (el.childElementCount === 0) {
        const t = (el.innerText || '').trim();
        if (t.length > bestLen && !t.startsWith('#') && !t.startsWith('{')) {
          best = t;
          bestLen = t.length;
        }
      }
    });
    // Also try larger containers
    for (const sel of ['[class*="summary"]', '[class*="result"]', '[class*="output"]', '[class*="content"]', 'ul', 'ol', 'p']) {
      const el = app.querySelector(sel);
      if (el) {
        const t = (el.innerText || '').trim();
        if (t.length > bestLen) { best = t; bestLen = t.length; }
      }
    }
    return best;
  }

  function checkAndSave() {
    // First try clipboard (via button click)
    tryScan();
    // Also try direct scrape as fallback
    const text = getSummaryText();
    if (text && text !== lastSavedText) {
      lastSavedText = text;
      downloadText(text);
    }
  }

  // ── Download ───────────────────────────────────────────────────────────────────────
  function downloadText(text) {
    if (!text || text === lastSavedText) return;
    lastSavedText = text;
    console.log('[AutoSave] downloading, length:', text.length);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = 'summaries/summary-' + timestamp + '.txt';
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename, saveAs: false }, () => {
      URL.revokeObjectURL(url);
    });
  }

  // ── Watch #app for DOM changes ─────────────────────────────────────────────────────
  let debounce = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounce);
    autoClickDone = false; // reset so we re-check for copy button after each change
    debounce = setTimeout(checkAndSave, 1500);
  });

  function startObserving() {
    const app = document.getElementById('app');
    if (app) {
      observer.observe(app, { childList: true, subtree: true, characterData: true });
      console.log('[AutoSave] observing #app ✓');
    } else {
      setTimeout(startObserving, 300);
    }
  }

  startObserving();
})();
