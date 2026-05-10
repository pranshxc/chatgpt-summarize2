// auto-save-handler.js
// Background SW message handler for DeepSeek cookie-based auth + auto-save.

import { getDeepSeekPowHeader } from './deepseek-pow.js';

// ── Storage watcher ────────────────────────────────────────────────────────────
chrome.storage.onChanged.addListener(function (changes, area) {
  for (const key of Object.keys(changes)) {
    const { oldValue, newValue } = changes[key];
    const text = extractSummaryText(newValue);
    if (text && text !== extractSummaryText(oldValue)) {
      doDownload(text, null);
    }
  }
});

function extractSummaryText(val) {
  if (!val) return null;
  if (typeof val === 'string') return looksLikeSummary(val) ? val : null;
  if (typeof val === 'object') {
    for (const field of ['summary', 'result', 'content', 'answer', 'text', 'output', 'response', 'message']) {
      if (looksLikeSummary(val[field])) return val[field];
    }
    for (const sub of Object.values(val)) {
      if (sub && typeof sub === 'object') {
        for (const field of ['summary', 'result', 'content', 'answer', 'text', 'output']) {
          if (looksLikeSummary(sub[field])) return sub[field];
        }
      }
    }
  }
  return null;
}

function looksLikeSummary(text) {
  if (typeof text !== 'string') return false;
  if (text.length < 150) return false;
  if (/^[\s]*[#.[\*@]/.test(text.slice(0, 10))) return false;
  if ((text.match(/[{}();]/g) || []).length / text.length > 0.06) return false;
  return (text.match(/[a-zA-Z]{4,}/g) || []).length > 20;
}

// ── Cookie helpers ─────────────────────────────────────────────────────────────

async function getDeepSeekCookieStr() {
  const urls = [
    'https://chat.deepseek.com',
    'https://www.deepseek.com',
    'https://deepseek.com',
  ];
  const seen = new Map();
  for (const url of urls) {
    try {
      const cookies = await chrome.cookies.getAll({ url });
      for (const c of cookies) {
        const key = `${c.name}|${c.domain}|${c.path}`;
        if (!seen.has(key)) seen.set(key, c);
      }
    } catch (e) {
      console.warn('[DeepSeek] cookie fetch failed for', url, e);
    }
  }
  if (seen.size === 0) return null;
  return Array.from(seen.values()).map(c => `${c.name}=${c.value}`).join('; ');
}

/**
 * Login status:
 * Considers the user logged in if ANY cookies exist for DeepSeek domains.
 * DeepSeek's cookie names vary across versions and regions — checking for a
 * specific name like ds_session_id is unreliable. Any cookie presence means
 * the browser has an active DeepSeek session.
 *
 * Also falls back to checking for a cached token in extension storage.
 */
async function getDeepSeekLoginStatus() {
  const urls = [
    'https://chat.deepseek.com',
    'https://www.deepseek.com',
    'https://deepseek.com',
  ];

  const seen = new Map();
  for (const url of urls) {
    try {
      const cookies = await chrome.cookies.getAll({ url });
      for (const c of cookies) {
        const key = `${c.name}|${c.domain}`;
        if (!seen.has(key)) seen.set(key, c);
      }
    } catch (e) {
      console.warn('[DeepSeek] login status cookie fetch failed for', url, e);
    }
  }

  const allCookies = Array.from(seen.values());
  const cookieCount = allCookies.length;
  const cookieNames = allCookies.map(c => c.name);

  // Any cookie = active browser session
  let loggedIn = cookieCount > 0;

  // Secondary: check cached token in storage (handles case where cookies
  // are httpOnly/not readable but user has previously logged in via the extension)
  if (!loggedIn) {
    try {
      const stored = await chrome.storage.local.get(['deepseek-token']);
      if (stored['deepseek-token']) loggedIn = true;
    } catch (e) {
      console.warn('[DeepSeek] storage check failed:', e);
    }
  }

  // Look for known session token cookie names for a better preview
  const knownNames = ['ds_session_id', 'ds_session', 'userToken', 'user_token',
    'ds_auth', 'authorization', 'NEXT_LOCALE', 'intercom-id'];
  const sessionCookie = allCookies.find(c =>
    knownNames.some(n => c.name.toLowerCase().includes(n.toLowerCase()))
  ) || allCookies[0] || null;

  console.log('[DeepSeek] Login status check:',
    'cookieCount:', cookieCount,
    'loggedIn:', loggedIn,
    'cookieNames:', cookieNames.slice(0, 10));

  return {
    loggedIn,
    cookieCount,
    sessionCookieName: sessionCookie?.name || null,
    allCookieNames: cookieNames,
  };
}

/**
 * Extract Bearer token from an open chat.deepseek.com tab via scripting injection.
 */
async function getDeepSeekToken() {
  // 1. Cached token
  const stored = await chrome.storage.local.get(['deepseek-token']);
  if (stored['deepseek-token']) {
    console.log('[DeepSeek] Using cached token');
    return stored['deepseek-token'];
  }

  // 2. Inject into an open DeepSeek tab
  try {
    const tabs = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
    const validTabs = tabs.filter(t =>
      t.url &&
      t.url.startsWith('https://chat.deepseek.com') &&
      t.status === 'complete'
    );

    for (const tab of validTabs) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            // Direct localStorage key search
            const directKeys = [
              'ds_user_auth', 'ds_auth', 'user_token', 'access_token',
              'auth_token', 'token', 'userToken', 'ds_token',
            ];
            for (const k of directKeys) {
              const v = localStorage.getItem(k);
              if (v && v.length > 20 && !v.startsWith('{')) return v;
            }

            // Search all localStorage JSON blobs
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i);
              const v = localStorage.getItem(k);
              if (!v) continue;
              try {
                const parsed = JSON.parse(v);
                const candidates = [
                  parsed?.token, parsed?.userToken, parsed?.access_token,
                  parsed?.data?.token, parsed?.data?.user?.token,
                  parsed?.state?.token, parsed?.state?.userToken,
                  parsed?.state?.user?.token,
                ];
                for (const c of candidates) {
                  if (c && typeof c === 'string' && c.length > 20) return c;
                }
              } catch {}
            }

            // Search Zustand/Redux window stores
            try {
              for (const wk of Object.keys(window)) {
                try {
                  const val = window[wk];
                  if (!val || typeof val !== 'object') continue;
                  const state = typeof val.getState === 'function' ? val.getState() : val;
                  const token = state?.token || state?.userToken ||
                    state?.auth?.token || state?.user?.token ||
                    state?.currentUser?.token;
                  if (token && typeof token === 'string' && token.length > 20) return token;
                } catch {}
              }
            } catch {}

            // Try __NEXT_DATA__
            try {
              const nd = window.__NEXT_DATA__;
              const token = nd?.props?.pageProps?.user?.token ||
                nd?.props?.initialState?.auth?.token;
              if (token && typeof token === 'string' && token.length > 20) return token;
            } catch {}

            return null;
          },
        });

        const token = results?.[0]?.result;
        if (token) {
          console.log('[DeepSeek] Token extracted from tab', tab.id);
          await chrome.storage.local.set({ 'deepseek-token': token });
          return token;
        }
      } catch (tabErr) {
        console.warn('[DeepSeek] Tab injection failed for tab', tab.id, ':', tabErr.message);
      }
    }
  } catch (e) {
    console.warn('[DeepSeek] Tab query error:', e.message);
  }

  console.warn('[DeepSeek] Token not found in any tab');
  return null;
}

function buildHeaders(token, cookieStr, extra = {}) {
  const h = {
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'x-app-version': '20250101.0',
    'x-client-platform': 'web',
    'x-client-locale': 'en_GB',
    'x-client-version': '20250101.0',
    ...extra,
  };
  if (token) h['Authorization'] = `Bearer ${token}`;
  if (cookieStr) h['Cookie'] = cookieStr;
  return h;
}

async function deepseekChat({ prompt, model_type = 'deepseek_v3', thinking_enabled = false, search_enabled = false }) {
  const token = await getDeepSeekToken();
  if (!token) throw new Error('Not logged in to DeepSeek. Open https://chat.deepseek.com and log in, then click \'Check Login Status\'.');

  const cookieStr = await getDeepSeekCookieStr();
  const headers = buildHeaders(token, cookieStr);

  // Step 1: Create session
  const sessionRes = await fetch('https://chat.deepseek.com/api/v0/chat_session/create', {
    method: 'POST', headers, credentials: 'omit', body: JSON.stringify({}),
  });
  if (!sessionRes.ok) {
    const t = await sessionRes.text();
    throw new Error(`Session create failed (${sessionRes.status}): ${t.slice(0, 200)}`);
  }
  const sessionJson = await sessionRes.json();
  const sessionId = sessionJson?.data?.biz_data?.chat_session?.id
    || sessionJson?.data?.id
    || sessionJson?.id;
  if (!sessionId) throw new Error(`No session ID in response: ${JSON.stringify(sessionJson).slice(0, 200)}`);

  // Step 2: Solve PoW
  let powHeader = null;
  try {
    powHeader = await getDeepSeekPowHeader(token, cookieStr, '/api/v0/chat/completion');
  } catch (powErr) {
    console.warn('[DeepSeek] PoW solve failed (proceeding without):', powErr.message);
  }

  // Step 3: Stream completion
  const completionHeaders = buildHeaders(token, cookieStr);
  if (powHeader) completionHeaders['x-ds-pow-response'] = powHeader;

  const completionRes = await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
    method: 'POST',
    headers: completionHeaders,
    credentials: 'omit',
    body: JSON.stringify({
      chat_session_id: sessionId,
      parent_message_id: null,
      model_type,
      prompt,
      ref_file_ids: [],
      thinking_enabled,
      search_enabled,
    }),
  });
  if (!completionRes.ok) {
    const t = await completionRes.text();
    throw new Error(`Completion failed (${completionRes.status}): ${t.slice(0, 200)}`);
  }

  // Step 4: Parse SSE stream
  const reader = completionRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let responseText = '';
  let thinkText = '';
  let inThinkPhase = true;
  let done = false;

  while (!done) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('event:')) continue;
      if (!trimmed.startsWith('data:')) continue;
      const jsonStr = trimmed.slice(5).trim();
      if (!jsonStr) continue;
      let evt;
      try { evt = JSON.parse(jsonStr); } catch { continue; }

      if (evt.v?.response?.fragments) {
        for (const frag of evt.v.response.fragments) {
          if (frag.type === 'THINK') { thinkText += frag.content || ''; inThinkPhase = true; }
          if (frag.type === 'RESPONSE') { responseText += frag.content || ''; inThinkPhase = false; }
        }
        continue;
      }
      if (evt.p === 'response/fragments' && evt.o === 'APPEND' && Array.isArray(evt.v)) {
        for (const frag of evt.v) {
          if (frag.type === 'THINK') inThinkPhase = true;
          if (frag.type === 'RESPONSE') inThinkPhase = false;
          if (frag.content) {
            if (inThinkPhase) thinkText += frag.content;
            else responseText += frag.content;
          }
        }
        continue;
      }
      if (evt.p && evt.p.includes('fragments') && evt.p.includes('content') && typeof evt.v === 'string') {
        if (inThinkPhase) thinkText += evt.v;
        else responseText += evt.v;
        continue;
      }
      if (!evt.p && typeof evt.v === 'string') {
        if (inThinkPhase) thinkText += evt.v;
        else responseText += evt.v;
        continue;
      }
      if (evt.click_behavior !== undefined) done = true;
    }
  }

  return { text: responseText.trim(), thinkText: thinkText.trim(), sessionId };
}

// ── Message handler ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {

  if (message && message.type === 'SUMMARY_AUTO_DOWNLOAD' && message.text) {
    doDownload(message.text, sender, sendResponse);
    return true;
  }

  if (message && message.type === 'GET_DEEPSEEK_COOKIES') {
    getDeepSeekCookieStr()
      .then(cookieStr => sendResponse({ cookieStr: cookieStr || null }))
      .catch(err => sendResponse({ cookieStr: null, error: err?.message }));
    return true;
  }

  if (message && message.type === 'GET_DEEPSEEK_STATUS') {
    getDeepSeekLoginStatus()
      .then(status => sendResponse(status))
      .catch(err => sendResponse({ loggedIn: false, cookieCount: 0, error: err?.message }));
    return true;
  }

  if (message && message.type === 'GET_DEEPSEEK_TOKEN') {
    getDeepSeekToken()
      .then(token => sendResponse({ token: token || null }))
      .catch(err => sendResponse({ token: null, error: err?.message }));
    return true;
  }

  if (message && message.type === 'DEEPSEEK_CHAT') {
    (async () => {
      try {
        const { prompt, model_type, thinking_enabled, search_enabled } = message;
        const result = await deepseekChat({ prompt, model_type, thinking_enabled, search_enabled });
        sendResponse({ ok: true, ...result });
      } catch (err) {
        console.error('[DeepSeek] DEEPSEEK_CHAT error:', err);
        sendResponse({ ok: false, error: err?.message || 'DeepSeek chat failed' });
      }
    })();
    return true;
  }

  if (message && message.type === 'DEEPSEEK_API_CALL') {
    (async () => {
      try {
        const { url, method = 'GET', body, extraHeaders = {} } = message;
        const cookieStr = await getDeepSeekCookieStr();
        const token = await getDeepSeekToken();
        const headers = buildHeaders(token, cookieStr, extraHeaders);
        const fetchOptions = { method, headers, credentials: 'omit' };
        if (body && method !== 'GET') fetchOptions.body = JSON.stringify(body);
        const res = await fetch(url, fetchOptions);
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch {}
        sendResponse({ ok: res.ok, status: res.status, data, rawText: text.slice(0, 500) });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || 'DEEPSEEK_API_CALL failed' });
      }
    })();
    return true;
  }
});

let lastDownloadedText = null;

function doDownload(text, sender, sendResponse) {
  if (!text || text === lastDownloadedText) {
    sendResponse && sendResponse({ success: false, reason: 'duplicate' });
    return;
  }
  lastDownloadedText = text;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = 'summaries/summary-' + timestamp + '.txt';
  const dataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
  chrome.downloads.download({ url: dataUrl, filename, saveAs: false }, function (downloadId) {
    if (chrome.runtime.lastError) {
      console.warn('[AutoSave] Download failed:', chrome.runtime.lastError.message);
      lastDownloadedText = null;
      sendResponse && sendResponse({ success: false, error: chrome.runtime.lastError.message });
    } else {
      chrome.storage.local.get(['_summaryHistory'], function (res) {
        const history = res._summaryHistory || [];
        history.unshift({ timestamp, text: text.slice(0, 500), url: (sender && sender.url) || '' });
        if (history.length > 50) history.length = 50;
        chrome.storage.local.set({ _summaryHistory: history });
      });
      sendResponse && sendResponse({ success: true, downloadId });
    }
  });
}
