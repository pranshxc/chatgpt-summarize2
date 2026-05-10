// auto-save-handler.js
// Handles:
//   1. SUMMARY_AUTO_DOWNLOAD  – download summary as .txt
//   2. GET_DEEPSEEK_COOKIES   – return raw cookie string for deepseek domains
//   3. GET_DEEPSEEK_STATUS    – check if user is logged in (has required cookies)
//   4. GET_DEEPSEEK_TOKEN     – return the userToken stored in DeepSeek's cookies/storage
//   5. DEEPSEEK_API_CALL      – proxy a DeepSeek API fetch from background (avoids CORS)

// ── Storage watcher ──────────────────────────────────────────────────────────
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
  if (typeof val === 'string') {
    return looksLikeSummary(val) ? val : null;
  }
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

// ── DeepSeek cookie helpers ───────────────────────────────────────────────────

/**
 * Collects all cookies from the DeepSeek domains.
 * Returns a cookie string like "name1=val1; name2=val2" or null if none found.
 */
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

  if (seen.size === 0) {
    console.warn('[DeepSeek] No cookies found across all DeepSeek domains');
    return null;
  }

  const cookieStr = Array.from(seen.values()).map(c => `${c.name}=${c.value}`).join('; ');
  console.log('[DeepSeek] Collected', seen.size, 'unique cookies across DeepSeek domains');
  return cookieStr;
}

/**
 * Checks whether the user appears to be logged in to DeepSeek.
 * We look for the presence of session-relevant cookie names that DeepSeek sets after login.
 * Returns: { loggedIn: boolean, cookieCount: number, missingCookies: string[] }
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
        seen.set(c.name, c.value);
      }
    } catch (e) {
      console.warn('[DeepSeek] status cookie fetch failed for', url, e);
    }
  }

  // DeepSeek sets these cookies on successful login.
  // 'intercom-session-*' and 'ds_session_token' are the most reliable indicators.
  const sessionIndicators = ['ds_session_token', 'Hm_lvt', 'intercom-id', '__cf_bm', 'ds_id'];
  const found = sessionIndicators.filter(name => seen.has(name));
  const missing = sessionIndicators.filter(name => !seen.has(name));

  // Consider logged in if we have at least 1 known session cookie AND total cookies > 3
  const loggedIn = found.length >= 1 && seen.size >= 2;

  return {
    loggedIn,
    cookieCount: seen.size,
    foundCookies: found,
    missingCookies: missing,
    allCookieNames: Array.from(seen.keys()),
  };
}

/**
 * Retrieves the DeepSeek user token.
 * Strategy:
 *   1. Check chrome.storage.local for a previously saved token
 *   2. Try to extract it from the DeepSeek cookies (ds_session_token)
 *   3. Try injecting a content script into an open chat.deepseek.com tab to read localStorage
 */
async function getDeepSeekToken() {
  // 1. Check cached token in extension storage
  const stored = await chrome.storage.local.get(['deepseek-token']);
  if (stored['deepseek-token']) {
    console.log('[DeepSeek] Using cached token from storage');
    return stored['deepseek-token'];
  }

  // 2. Check if ds_session_token cookie exists (DeepSeek sometimes uses this as the bearer)
  try {
    const cookies = await chrome.cookies.getAll({ url: 'https://chat.deepseek.com' });
    const sessionCookie = cookies.find(c => c.name === 'ds_session_token' || c.name === 'ds_auth_token' || c.name === 'user_token');
    if (sessionCookie) {
      console.log('[DeepSeek] Found token in cookie:', sessionCookie.name);
      await chrome.storage.local.set({ 'deepseek-token': sessionCookie.value });
      return sessionCookie.value;
    }
  } catch (e) {
    console.warn('[DeepSeek] Cookie token read failed:', e);
  }

  // 3. Try to inject into an open DeepSeek tab and read localStorage
  try {
    const tabs = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
    if (tabs.length > 0) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: () => {
          // DeepSeek stores auth in localStorage under various keys
          const candidates = [
            'ds_user_token', 'userToken', 'token', 'auth_token',
            'deepseek_token', 'access_token', 'ds_token',
          ];
          for (const key of candidates) {
            const val = localStorage.getItem(key);
            if (val && val.length > 10) return val;
          }
          // Try to find it inside a JSON blob
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            const v = localStorage.getItem(k);
            try {
              const parsed = JSON.parse(v);
              const token = parsed?.token || parsed?.userToken || parsed?.access_token
                || parsed?.data?.token || parsed?.data?.user?.token;
              if (token && typeof token === 'string' && token.length > 10) return token;
            } catch {}
          }
          return null;
        },
      });
      const token = results?.[0]?.result;
      if (token) {
        console.log('[DeepSeek] Extracted token from DeepSeek tab localStorage');
        await chrome.storage.local.set({ 'deepseek-token': token });
        return token;
      }
    }
  } catch (e) {
    console.warn('[DeepSeek] localStorage injection failed:', e);
  }

  console.warn('[DeepSeek] Could not find token anywhere');
  return null;
}

// ── Message handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {

  // ── Auto-download trigger from content script
  if (message && message.type === 'SUMMARY_AUTO_DOWNLOAD' && message.text) {
    doDownload(message.text, sender, sendResponse);
    return true;
  }

  // ── Return raw cookie string (used by chunk-LBLDOCW3.js for API calls)
  if (message && message.type === 'GET_DEEPSEEK_COOKIES') {
    getDeepSeekCookieStr().then(cookieStr => {
      sendResponse({ cookieStr: cookieStr || null });
    }).catch(err => {
      console.error('[DeepSeek] GET_DEEPSEEK_COOKIES error:', err);
      sendResponse({ cookieStr: null, error: err?.message });
    });
    return true;
  }

  // ── Return login status (is the user logged in to chat.deepseek.com?)
  if (message && message.type === 'GET_DEEPSEEK_STATUS') {
    getDeepSeekLoginStatus().then(status => {
      sendResponse(status);
    }).catch(err => {
      console.error('[DeepSeek] GET_DEEPSEEK_STATUS error:', err);
      sendResponse({ loggedIn: false, error: err?.message });
    });
    return true;
  }

  // ── Return the user token (extracted from cookies / localStorage)
  if (message && message.type === 'GET_DEEPSEEK_TOKEN') {
    getDeepSeekToken().then(token => {
      sendResponse({ token: token || null });
    }).catch(err => {
      console.error('[DeepSeek] GET_DEEPSEEK_TOKEN error:', err);
      sendResponse({ token: null, error: err?.message });
    });
    return true;
  }

  // ── Proxy a DeepSeek API fetch through the background SW (avoids CORS/origin blocks)
  if (message && message.type === 'DEEPSEEK_API_CALL') {
    (async () => {
      try {
        const { url, method = 'GET', body, extraHeaders = {} } = message;

        const cookieStr = await getDeepSeekCookieStr();
        const token = await getDeepSeekToken();

        const headers = {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-app-version': '20241129.1',
          'x-client-platform': 'web',
          'x-client-locale': 'en_US',
          ...extraHeaders,
        };
        if (cookieStr) headers['Cookie'] = cookieStr;
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const fetchOptions = { method, headers, credentials: 'omit' };
        if (body && method !== 'GET') fetchOptions.body = JSON.stringify(body);

        const res = await fetch(url, fetchOptions);
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch {}

        sendResponse({
          ok: res.ok,
          status: res.status,
          data,
          rawText: text.slice(0, 500),
          contentType: res.headers.get('content-type') || '',
        });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || 'DEEPSEEK_API_CALL failed' });
      }
    })();
    return true;
  }

  // ── Legacy: full login from background (kept for backwards compat)
  if (message && message.type === 'DEEPSEEK_LOGIN') {
    (async () => {
      try {
        const { email, password } = message;
        const cookieStr = await getDeepSeekCookieStr();
        const headers = {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-app-version': '20241129.1',
          'x-client-platform': 'web',
          'x-client-locale': 'en_US',
        };
        if (cookieStr) headers['Cookie'] = cookieStr;

        const res = await fetch('https://chat.deepseek.com/api/v0/users/login', {
          method: 'POST',
          headers,
          credentials: 'omit',
          body: JSON.stringify({ email, password, mobile: '', area_code: '', device_id: '', os: 'web' }),
        });

        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch {}

        if (!text && !cookieStr) {
          sendResponse({ error: 'DeepSeek requires browser cookies.\n\nPlease log in at https://chat.deepseek.com first, then try again.' });
          return;
        }
        if (!text) {
          sendResponse({ error: `DeepSeek returned empty response (HTTP ${res.status}). Please wait and retry.` });
          return;
        }
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('application/json')) {
          sendResponse({ error: 'DeepSeek returned a bot-protection page. Please open https://chat.deepseek.com, solve any CAPTCHA, log in, then try again.' });
          return;
        }
        if (!res.ok) {
          sendResponse({ error: data?.error || data?.detail?.message || data?.message || `Login failed (HTTP ${res.status})` });
          return;
        }
        if (data?.data?.user?.token) {
          await chrome.storage.local.set({
            'deepseek-token': data.data.user.token,
            'deepseek-login': email,
            'deepseek-password': password,
          });
          sendResponse({ token: data.data.user.token });
          return;
        }
        sendResponse({ error: `Unexpected response format. Raw: ${text.slice(0, 200)}` });
      } catch (err) {
        sendResponse({ error: err?.message || 'DeepSeek login failed in background worker' });
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

  chrome.downloads.download(
    { url: dataUrl, filename: filename, saveAs: false },
    function (downloadId) {
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
    }
  );
}
