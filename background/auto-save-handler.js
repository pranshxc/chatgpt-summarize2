// auto-save-handler.js
// Background SW message handler for DeepSeek cookie-based auth + auto-save.
//
// Message types handled:
//   SUMMARY_AUTO_DOWNLOAD   – download summary text as .txt
//   GET_DEEPSEEK_COOKIES    – return raw cookie string
//   GET_DEEPSEEK_STATUS     – check login via ds_session_id cookie
//   GET_DEEPSEEK_TOKEN      – extract Bearer token from open deepseek tab
//   DEEPSEEK_CHAT           – full 2-step chat: create_session -> PoW -> SSE completion
//   DEEPSEEK_API_CALL       – generic proxied fetch (legacy)
//   DEEPSEEK_LOGIN          – email/password login (legacy)

// getDeepSeekPowHeader is provided by deepseek-pow.js which is imported
// as a sibling ES module in sw-entry.js before this file.
// We import it directly so this module works standalone too.
import { getDeepSeekPowHeader } from './deepseek-pow.js';

// ── Storage watcher ────────────────────────────────────────────────────────────
chrome.storage.onChanged.addListener(function (changes, area) {
  for (const key of Object.keys(changes)) {
    const { oldValue, newValue } = changes[key];
    const preview = typeof newValue === 'string'
      ? newValue.slice(0, 120)
      : (newValue && typeof newValue === 'object'
          ? JSON.stringify(newValue).slice(0, 120)
          : String(newValue));
    console.log('[AutoSave][storage.onChanged]', area, 'key:', key, '| preview:', preview);
    const text = extractSummaryText(newValue);
    if (text && text !== extractSummaryText(oldValue)) {
      console.log('[AutoSave] Detected summary in key:', key, '- triggering download');
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
 * Login status: look for ds_session_id cookie (confirmed from network trace).
 */
async function getDeepSeekLoginStatus() {
  const allCookies = await chrome.cookies.getAll({ url: 'https://chat.deepseek.com' });
  const byName = new Map(allCookies.map(c => [c.name, c.value]));
  const sessionId = byName.get('ds_session_id') || null;
  return {
    loggedIn: !!sessionId,
    cookieCount: allCookies.length,
    sessionId: sessionId ? sessionId.slice(0, 8) + '...' : null,
    allCookieNames: allCookies.map(c => c.name),
  };
}

/**
 * Extract Bearer token from an open chat.deepseek.com tab via scripting injection.
 * Only injects into real https://chat.deepseek.com/* tabs (avoids browser-specific page errors).
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
    // Guard: only inject into real, fully-loaded https://chat.deepseek.com pages
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
            // Known direct localStorage keys
            const directKeys = [
              'ds_user_auth', 'ds_auth', 'user_token', 'access_token',
              'auth_token', 'token', 'userToken', 'ds_token',
            ];
            for (const k of directKeys) {
              const v = localStorage.getItem(k);
              if (v && v.length > 20 && !v.startsWith('{')) return v;
            }

            // Search all localStorage JSON blobs for a token field
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
                ];
                for (const c of candidates) {
                  if (c && typeof c === 'string' && c.length > 20) return c;
                }
              } catch {}
            }

            // Search Zustand/Redux window stores
            try {
              for (const wk of Object.keys(window)) {
                if (!wk.startsWith('__') && !wk.toLowerCase().includes('store')) continue;
                try {
                  const state = window[wk]?.getState?.();
                  const token = state?.token || state?.userToken
                    || state?.auth?.token || state?.user?.token;
                  if (token && typeof token === 'string' && token.length > 20) return token;
                } catch {}
              }
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

/**
 * Build standard DeepSeek request headers.
 */
function buildHeaders(token, cookieStr, extra = {}) {
  const h = {
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'x-app-version': '2.0.0',
    'x-client-platform': 'web',
    'x-client-locale': 'en_GB',
    'x-client-version': '2.0.0',
    'x-client-timezone-offset': '19800',
    ...extra,
  };
  if (token) h['Authorization'] = `Bearer ${token}`;
  if (cookieStr) h['Cookie'] = cookieStr;
  return h;
}

/**
 * Full DeepSeek chat pipeline:
 *   1. Create session
 *   2. Solve PoW challenge
 *   3. Stream completion (SSE)
 *   4. Parse THINK + RESPONSE fragments
 */
async function deepseekChat({ prompt, model_type = 'default', thinking_enabled = true, search_enabled = false }) {
  const token = await getDeepSeekToken();
  if (!token) throw new Error('Not logged in to DeepSeek. Open https://chat.deepseek.com and log in, then try again.');

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
  const sessionId = sessionJson?.data?.biz_data?.chat_session?.id;
  if (!sessionId) throw new Error(`No session ID in response: ${JSON.stringify(sessionJson).slice(0, 200)}`);
  console.log('[DeepSeek] Session created:', sessionId);

  // Step 2: Solve PoW
  let powHeader = null;
  try {
    powHeader = await getDeepSeekPowHeader(token, cookieStr, '/api/v0/chat/completion');
    console.log('[DeepSeek] PoW solved');
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
      preempt: false,
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
  let inThinkPhase = true; // first fragments are THINK, then RESPONSE
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

      // Full fragment list (first data event)
      if (evt.v?.response?.fragments) {
        for (const frag of evt.v.response.fragments) {
          if (frag.type === 'THINK') { thinkText += frag.content || ''; inThinkPhase = true; }
          if (frag.type === 'RESPONSE') { responseText += frag.content || ''; inThinkPhase = false; }
        }
        continue;
      }

      // New fragment appended: { p: 'response/fragments', o: 'APPEND', v: [{type, content}] }
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

      // Content patch: { p: 'response/fragments/-1/content', o: 'APPEND'/'SET', v: '...' }
      if (evt.p && evt.p.includes('fragments') && evt.p.includes('content') && typeof evt.v === 'string') {
        if (inThinkPhase) thinkText += evt.v;
        else responseText += evt.v;
        continue;
      }

      // Shorthand content append: { v: '...' } (no p)
      if (!evt.p && typeof evt.v === 'string') {
        if (inThinkPhase) thinkText += evt.v;
        else responseText += evt.v;
        continue;
      }

      // Close event
      if (evt.click_behavior !== undefined) { done = true; }
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
      .catch(err => sendResponse({ loggedIn: false, error: err?.message }));
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
        sendResponse({ ok: res.ok, status: res.status, data, rawText: text.slice(0, 500), contentType: res.headers.get('content-type') || '' });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || 'DEEPSEEK_API_CALL failed' });
      }
    })();
    return true;
  }

  if (message && message.type === 'DEEPSEEK_LOGIN') {
    (async () => {
      try {
        const { email, password } = message;
        const cookieStr = await getDeepSeekCookieStr();
        const headers = buildHeaders(null, cookieStr);
        const res = await fetch('https://chat.deepseek.com/api/v0/users/login', {
          method: 'POST', headers, credentials: 'omit',
          body: JSON.stringify({ email, password, mobile: '', area_code: '', device_id: '', os: 'web' }),
        });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch {}
        if (!res.ok) {
          sendResponse({ error: data?.error || data?.detail?.message || `Login failed (${res.status})` });
          return;
        }
        if (data?.data?.user?.token) {
          await chrome.storage.local.set({ 'deepseek-token': data.data.user.token, 'deepseek-login': email, 'deepseek-password': password });
          sendResponse({ token: data.data.user.token });
          return;
        }
        sendResponse({ error: `Unexpected response: ${text.slice(0, 200)}` });
      } catch (err) {
        sendResponse({ error: err?.message || 'Login failed' });
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
      console.log('[AutoSave] Saved:', filename, '| ID:', downloadId);
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
