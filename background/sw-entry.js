// sw-entry.js — Service Worker entry point (ES module)
//
// IMPORT ORDER IS CRITICAL:
// auto-save-handler.js MUST be imported before index.js.
// index.js (the main compiled bundle) registers a catch-all onMessage listener.
// If it runs first, it consumes GET_DEEPSEEK_STATUS / GET_DEEPSEEK_TOKEN
// messages before auto-save-handler.js can respond — causing the UI to always
// receive null and fall back to { loggedIn: false }.
//
// deepseek-pow.js must come before auto-save-handler.js because
// auto-save-handler.js imports getDeepSeekPowHeader from it.

// ─────────────────────────────────────────────────────────────────────────────
// DEEPSEEK FETCH INTERCEPT
//
// index.js drives a 3-step flow:
//   1. POST /api/v0/users/login         → 202 + empty body → crash
//   2. POST /api/v0/chat_session/create → sends fake "cookie-auth" Bearer token
//                                          → DeepSeek returns 40003 invalid token
//   3. POST /api/v0/chat/completion     → never reached
//
// We own all three endpoints:
//   1. Login:   return synthetic 200 JSON so index.js proceeds
//   2. Session: strip index.js’s headers, rebuild with real cookies from storage,
//               send the real request, return its real response
//   3. Completion: skip the real network call entirely — run deepseekChat()
//               (which does session+completion internally with real auth) and
//               return a synthetic SSE stream that index.js can parse
// ─────────────────────────────────────────────────────────────────────────────

// ── Response.json() empty-body guard ────────────────────────────────────────
(function patchResponseJson() {
  Response.prototype.json = function () {
    var self = this;
    return self.clone().text().then(function (text) {
      if (!text || !text.trim()) {
        console.warn('[sw-patch] Response.json(): empty body (status ' + self.status + ') — returning null.');
        return null;
      }
      try {
        return JSON.parse(text);
      } catch (e) {
        console.warn('[sw-patch] Response.json() parse error:', e.message, '— returning null.');
        return null;
      }
    });
  };
})();

// ── DeepSeek fetch intercept ─────────────────────────────────────────────────
(function patchDeepSeekFetch() {
  var _origFetch = self.fetch.bind(self);

  self.fetch = async function (input, init) {
    var url = typeof input === 'string' ? input
            : (input && input.url ? input.url : String(input));

    // ── 1. Login — synthetic 200, no network call ──────────────────────────
    if (url.includes('chat.deepseek.com/api/v0/users/login')) {
      console.log('[sw-patch] Intercepted DeepSeek login — returning synthetic 200.');
      return new Response(
        JSON.stringify({ code: 0, data: { user_id: 'cookie-auth', token: 'cookie-auth' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ── 2. Session create — rebuild with real cookies, strip fake token ───────
    if (url.includes('chat.deepseek.com/api/v0/chat_session/create')) {
      console.log('[sw-patch] Intercepted DeepSeek session create — rebuilding with real auth.');
      try {
        // Get real cookies from storage (set by auto-save-handler)
        var cookieStr = await getRealCookieStr();
        var realToken = await getRealToken();

        var cleanHeaders = {
          'Content-Type': 'application/json',
          'Accept': '*/*',
          'x-app-version': '20250101.0',
          'x-client-platform': 'web',
          'x-client-locale': 'en_GB',
          'x-client-version': '20250101.0',
        };
        // Only set Authorization if we have a REAL token (not the fake one)
        if (realToken && realToken !== 'cookie-auth') {
          cleanHeaders['Authorization'] = 'Bearer ' + realToken;
        }
        if (cookieStr) cleanHeaders['Cookie'] = cookieStr;

        return _origFetch(url, {
          method: 'POST',
          headers: cleanHeaders,
          credentials: 'omit',
          body: JSON.stringify({}),
        });
      } catch (err) {
        console.error('[sw-patch] Session create rebuild failed:', err);
        return _origFetch(input, init);
      }
    }

    // ── 3. Completion — run through deepseekChat(), return synthetic SSE ─────
    if (url.includes('chat.deepseek.com/api/v0/chat/completion')) {
      console.log('[sw-patch] Intercepted DeepSeek completion — routing through deepseekChat().');
      try {
        var bodyStr = (init && init.body) ? init.body : '{}';
        var bodyObj = {};
        try { bodyObj = JSON.parse(bodyStr); } catch (e) {}

        var chatFn = self.__deepseekChat;
        if (!chatFn) {
          console.warn('[sw-patch] __deepseekChat not ready, falling through.');
          return _origFetch(input, init);
        }

        var result = await chatFn({
          prompt: bodyObj.prompt || '',
          model_type: bodyObj.model_type || 'deepseek_v3',
          thinking_enabled: bodyObj.thinking_enabled || false,
          search_enabled: bodyObj.search_enabled || false,
        });

        var lines = [];
        if (result.thinkText) {
          lines.push('data: ' + JSON.stringify({
            p: 'response/fragments', o: 'APPEND',
            v: [{ type: 'THINK', content: result.thinkText }]
          }));
          lines.push('');
        }
        if (result.text) {
          lines.push('data: ' + JSON.stringify({
            p: 'response/fragments', o: 'APPEND',
            v: [{ type: 'RESPONSE', content: result.text }]
          }));
          lines.push('');
        }
        lines.push('data: ' + JSON.stringify({ click_behavior: 'stop' }));
        lines.push('');

        return new Response(lines.join('\n'), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      } catch (err) {
        console.error('[sw-patch] deepseekChat failed:', err);
        return new Response(
          JSON.stringify({ code: -1, message: err.message }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    return _origFetch(input, init);
  };

  // ── Helpers: read real auth from chrome.storage + cookies ─────────────────
  async function getRealCookieStr() {
    const DS_URLS = [
      'https://chat.deepseek.com',
      'https://www.deepseek.com',
      'https://deepseek.com',
    ];
    const seen = new Map();
    for (const url of DS_URLS) {
      try {
        const cookies = await chrome.cookies.getAll({ url });
        for (const c of cookies) {
          const key = c.name + '|' + c.domain + '|' + c.path;
          if (!seen.has(key)) seen.set(key, c);
        }
      } catch (e) {}
    }
    const all = Array.from(seen.values());
    if (!all.length) return null;
    return all.map(function(c) { return c.name + '=' + c.value; }).join('; ');
  }

  async function getRealToken() {
    try {
      const s = await chrome.storage.local.get(['deepseek-token']);
      return s['deepseek-token'] || null;
    } catch (e) { return null; }
  }
})();

import './deepseek-pow.js';
import './auto-save-handler.js';
import './index.js';

// ── MV3 Service Worker keepalive ─────────────────────────────────────────────
chrome.alarms.create('sw-keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === 'sw-keepalive') {
    chrome.storage.local.get('_swPing', function () {});
  }
});
