(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────────
  // PART 1: Auto-save summary (unchanged from original)
  // ─────────────────────────────────────────────────────────────────────────────

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
      const rb = small[i+1].getBoundingClientRect();
      const rc = small[i+2].getBoundingClientRect();
      if (
        Math.max(ra.top, rb.top, rc.top) - Math.min(ra.top, rb.top, rc.top) < 20 &&
        Math.max(ra.left, rb.left, rc.left) - Math.min(ra.left, rb.left, rc.left) < 160
      ) {
        return [small[i], small[i+1], small[i+2]]
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
    for (const sel of ['[class*="summary"]','[class*="result"]','[class*="output"]','[class*="content"]','ul','ol','p']) {
      const el = app.querySelector(sel);
      if (el) { const t = (el.innerText||'').trim(); if (t.length > bestLen) { best = t; bestLen = t.length; } }
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
    lastSavedText = text;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: 'summaries/summary-' + timestamp + '.txt', saveAs: false }, () => URL.revokeObjectURL(url));
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

  // ─────────────────────────────────────────────────────────────────────────────
  // PART 2: DeepSeek status panel injection
  // Bypasses the compiled bundle entirely — injects straight into the live DOM.
  // ─────────────────────────────────────────────────────────────────────────────

  function sendBg(type, extra) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type, ...extra }, response => {
          if (chrome.runtime.lastError) {
            console.warn('[DS Panel] sendMessage error:', chrome.runtime.lastError.message);
            resolve(null);
            return;
          }
          resolve(response || null);
        });
      } catch (e) {
        console.warn('[DS Panel] sendMessage threw:', e);
        resolve(null);
      }
    });
  }

  // Styles for the injected panel
  const STYLES = `
    #ds-status-panel {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      padding: 10px 12px;
      margin: 6px 8px;
      border-radius: 8px;
      border: 1px solid #e5e7eb;
      background: #f9fafb;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    @media (prefers-color-scheme: dark) {
      #ds-status-panel { background: #1f2937; border-color: #374151; color: #f3f4f6; }
    }
    #ds-status-panel .ds-badge {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-radius: 6px;
      font-weight: 500;
    }
    #ds-status-panel .ds-badge.connected { background: #dcfce7; color: #166534; }
    #ds-status-panel .ds-badge.disconnected { background: #fff7ed; color: #9a3412; }
    @media (prefers-color-scheme: dark) {
      #ds-status-panel .ds-badge.connected { background: #14532d; color: #86efac; }
      #ds-status-panel .ds-badge.disconnected { background: #431407; color: #fdba74; }
    }
    #ds-status-panel .ds-dot {
      width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0;
    }
    #ds-status-panel .ds-dot.green { background: #22c55e; }
    #ds-status-panel .ds-dot.orange { background: #f97316; }
    #ds-status-panel .ds-hint {
      font-size: 11px;
      color: #6b7280;
      line-height: 1.4;
    }
    #ds-status-panel .ds-hint a { color: #6366f1; text-decoration: underline; }
    #ds-status-panel .ds-hint.warn { color: #d97706; }
    #ds-status-panel .ds-buttons {
      display: flex; gap: 6px; align-items: center;
    }
    #ds-status-panel button {
      padding: 4px 10px;
      border-radius: 5px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid #d1d5db;
      background: #fff;
      color: #374151;
      transition: background 0.15s;
    }
    #ds-status-panel button:hover { background: #f3f4f6; }
    #ds-status-panel button:disabled { opacity: 0.5; cursor: default; }
    #ds-status-panel button.ds-btn-primary {
      background: #6366f1; color: #fff; border-color: #6366f1;
    }
    #ds-status-panel button.ds-btn-primary:hover { background: #4f46e5; }
    #ds-status-panel button.ds-btn-danger {
      background: #ef4444; color: #fff; border-color: #ef4444;
    }
    #ds-status-panel button.ds-btn-danger:hover { background: #dc2626; }
    #ds-status-panel .ds-loading { color: #9ca3af; font-size: 12px; }
  `;

  function injectStyle() {
    if (document.getElementById('ds-panel-style')) return;
    const s = document.createElement('style');
    s.id = 'ds-panel-style';
    s.textContent = STYLES;
    document.head.appendChild(s);
  }

  // Remove old login form injected by the compiled bundle
  // The form contains an email input — find it and hide its container
  function removeOldLoginForm() {
    const inputs = document.querySelectorAll('input[type="email"], input[placeholder*="mail" i], input[placeholder*="login" i]');
    inputs.forEach(input => {
      // Walk up to find the section/card container
      let el = input;
      for (let i = 0; i < 6; i++) {
        if (!el.parentElement) break;
        el = el.parentElement;
        const tag = el.tagName.toLowerCase();
        if (tag === 'section' || tag === 'form' || tag === 'div' && el.childElementCount <= 5) {
          el.style.display = 'none';
          break;
        }
      }
    });
  }

  let panelState = { status: 'loading', tokenPreview: null, tokenHint: null, checking: false };
  let panelEl = null;

  function renderPanel() {
    if (!panelEl) return;
    const { status, tokenPreview, tokenHint, checking } = panelState;

    if (status === 'loading') {
      panelEl.innerHTML = `<span class="ds-loading">⏳ Checking DeepSeek session…</span>`;
      return;
    }

    if (status === 'connected') {
      panelEl.innerHTML = `
        <div class="ds-badge connected">
          <span class="ds-dot green"></span>
          <span>Connected to DeepSeek
            ${tokenPreview ? ` <span style="font-weight:400;font-size:11px;opacity:.7">• token ${tokenPreview}</span>` : ''}
          </span>
        </div>
        ${tokenHint ? `<p class="ds-hint warn">⚠️ ${tokenHint}</p>` : ''}
        <p class="ds-hint">Your browser session is used automatically. No credentials needed.</p>
        <div class="ds-buttons">
          <button id="ds-refresh-btn" ${checking ? 'disabled' : ''}>${checking ? '…' : '↻ Refresh'}</button>
          <button id="ds-disconnect-btn" class="ds-btn-danger">Disconnect</button>
        </div>
      `;
    } else {
      panelEl.innerHTML = `
        <div class="ds-badge disconnected">
          <span class="ds-dot orange"></span>
          <span>Not connected to DeepSeek</span>
        </div>
        <p class="ds-hint">
          Log in at <a href="https://chat.deepseek.com" target="_blank" rel="noopener">chat.deepseek.com</a>
          in your browser, then click the button below.
        </p>
        <div class="ds-buttons">
          <button id="ds-refresh-btn" class="ds-btn-primary" ${checking ? 'disabled' : ''}>
            ${checking ? '…' : 'Check Login Status'}
          </button>
        </div>
      `;
    }

    // Wire buttons
    const refreshBtn = document.getElementById('ds-refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', runCheck);

    const disconnectBtn = document.getElementById('ds-disconnect-btn');
    if (disconnectBtn) disconnectBtn.addEventListener('click', async () => {
      try {
        await chrome.storage.local.remove(['deepseek-token', 'deepseek-login', 'deepseek-password']);
      } catch (e) { console.warn('[DS Panel] disconnect error:', e); }
      panelState = { status: 'disconnected', tokenPreview: null, tokenHint: null, checking: false };
      renderPanel();
    });
  }

  async function runCheck() {
    panelState.checking = true;
    renderPanel();

    try {
      // 1. Check login status via ds_session_id cookie
      const statusResp = await sendBg('GET_DEEPSEEK_STATUS');
      console.log('[DS Panel] GET_DEEPSEEK_STATUS response:', statusResp);

      if (!statusResp || !statusResp.loggedIn) {
        panelState = { status: 'disconnected', tokenPreview: null, tokenHint: null, checking: false };
        renderPanel();
        return;
      }

      // 2. Try to get Bearer token from open DeepSeek tab
      const tokenResp = await sendBg('GET_DEEPSEEK_TOKEN');
      console.log('[DS Panel] GET_DEEPSEEK_TOKEN response:', tokenResp);

      const token = tokenResp?.token || null;
      let preview = null;
      let hint = null;

      if (token) {
        preview = token.slice(0, 12) + '…';
        // Cache it
        try { await chrome.storage.local.set({ 'deepseek-token': token }); } catch (e) {}
      } else {
        hint = 'Keep a chat.deepseek.com tab open so the extension can read your session token.';
      }

      panelState = {
        status: 'connected',
        tokenPreview: preview,
        tokenHint: hint,
        checking: false,
      };
      renderPanel();
    } catch (err) {
      console.error('[DS Panel] runCheck error:', err);
      panelState = { status: 'disconnected', tokenPreview: null, tokenHint: 'Error: ' + err.message, checking: false };
      renderPanel();
    }
  }

  function createPanel() {
    if (document.getElementById('ds-status-panel')) return;
    injectStyle();

    panelEl = document.createElement('div');
    panelEl.id = 'ds-status-panel';
    panelEl.innerHTML = `<span class="ds-loading">⏳ Checking DeepSeek session…</span>`;

    // Find the best insertion point:
    // 1. Right before the old login form / first input section
    // 2. Or at the top of #app
    const app = document.getElementById('app');
    if (!app) return;

    // Try to find a settings/login section to insert before
    const loginSection = app.querySelector('input[type="email"], input[type="password"], input[placeholder*="mail" i]');
    if (loginSection) {
      let container = loginSection;
      for (let i = 0; i < 5; i++) {
        if (!container.parentElement || container.parentElement === app) break;
        container = container.parentElement;
      }
      app.insertBefore(panelEl, container);
    } else {
      // Insert as first child of #app
      app.insertBefore(panelEl, app.firstChild);
    }

    // Hide old login form
    removeOldLoginForm();

    // Auto-run check
    runCheck();
  }

  // Wait for the React app to finish rendering before injecting the panel.
  // The compiled bundle renders asynchronously so we poll.
  let injectAttempts = 0;
  function tryInject() {
    const app = document.getElementById('app');
    // Wait until #app has some children (React has rendered)
    if (app && app.children.length > 0) {
      createPanel();
    } else if (injectAttempts < 30) {
      injectAttempts++;
      setTimeout(tryInject, 200);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(tryInject, 300));
  } else {
    setTimeout(tryInject, 300);
  }

})();
