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
// WHY THIS IS NEEDED:
// index.js contains a DeepSeek provider class (ff) that drives a 3-step flow:
//   1. POST /api/v0/users/login       → expects JSON body, gets 202 + empty body
//   2. POST /api/v0/chat_session/create → works, returns session ID
//   3. POST /api/v0/chat/completion   → NEVER REACHED because step 1 null
//      propagates into createSession which then has no session ID to send
//
// auto-save-handler.js already contains a fully-working deepseekChat() that
// handles cookies, session creation, PoW header, streaming — everything.
// We intercept the three DeepSeek API calls that index.js makes and:
//   - Login:      return a fake 200 OK with {"code":0,"data":{"user_id":"patched"}}
//                 so index.js's createSession proceeds with a non-null user object
//   - Session:    pass through normally (it works)
//   - Completion: intercept the body, run it through deepseekChat() instead,
//                 and return a synthetic SSE stream with the result so index.js
//                 can parse it the same way it would a real stream
// ─────────────────────────────────────────────────────────────────────────────

// ── Response.json() empty-body guard ────────────────────────────────────────
// Kept as a safety net for any other endpoint that returns an empty body.
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

  // Holds the prompt+options from the completion call so deepseekChat can use them
  var pendingCompletionBody = null;

  self.fetch = async function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));

    // ── 1. Login — return a fake 200 so index.js createSession proceeds ───
    if (url.includes('chat.deepseek.com/api/v0/users/login')) {
      console.log('[sw-patch] Intercepted DeepSeek login — returning synthetic 200.');
      return new Response(
        JSON.stringify({ code: 0, data: { user_id: 'cookie-auth', token: 'cookie-auth' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ── 2. Session create — pass through, but capture result ─────────────
    if (url.includes('chat.deepseek.com/api/v0/chat_session/create')) {
      console.log('[sw-patch] Passing through DeepSeek session create.');
      return _origFetch(input, init);
    }

    // ── 3. Completion — run through deepseekChat, return SSE stream ───────
    if (url.includes('chat.deepseek.com/api/v0/chat/completion')) {
      console.log('[sw-patch] Intercepted DeepSeek completion — routing through deepseekChat().');
      try {
        // Parse the body to get the prompt
        var bodyStr = (init && init.body) ? init.body : '{}';
        var bodyObj = {};
        try { bodyObj = JSON.parse(bodyStr); } catch (e) {}
        var prompt = bodyObj.prompt || '';
        var model_type = bodyObj.model_type || 'deepseek_v3';
        var thinking_enabled = bodyObj.thinking_enabled || false;
        var search_enabled = bodyObj.search_enabled || false;

        // deepseekChat is defined in auto-save-handler.js which is imported
        // before this patch runs. We call it via a globally-set reference.
        // auto-save-handler sets self.__deepseekChat after it defines the fn.
        var chatFn = self.__deepseekChat;
        if (!chatFn) {
          console.warn('[sw-patch] __deepseekChat not ready yet, falling through to real fetch.');
          return _origFetch(input, init);
        }

        var result = await chatFn({ prompt, model_type, thinking_enabled, search_enabled });
        var text = result.text || '';
        var thinkText = result.thinkText || '';

        // Build a synthetic SSE stream that index.js can parse.
        // index.js reads lines starting with "data:" and parses the JSON.
        // It looks for evt.p === 'response/fragments' with APPEND + array of frags.
        var lines = [];
        if (thinkText) {
          lines.push('data: ' + JSON.stringify({
            p: 'response/fragments',
            o: 'APPEND',
            v: [{ type: 'THINK', content: thinkText }]
          }));
          lines.push('');
        }
        if (text) {
          lines.push('data: ' + JSON.stringify({
            p: 'response/fragments',
            o: 'APPEND',
            v: [{ type: 'RESPONSE', content: text }]
          }));
          lines.push('');
        }
        // Terminal event that index.js uses to detect stream end
        lines.push('data: ' + JSON.stringify({ click_behavior: 'stop' }));
        lines.push('');
        var sseBody = lines.join('\n');

        return new Response(sseBody, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Transfer-Encoding': 'chunked',
          }
        });
      } catch (err) {
        console.error('[sw-patch] deepseekChat failed:', err);
        // Return a 500 so index.js surfaces a real error rather than hanging
        return new Response(
          JSON.stringify({ code: -1, message: err.message }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    // All other requests pass through unchanged
    return _origFetch(input, init);
  };
})();

import './deepseek-pow.js';
import './auto-save-handler.js';
import './index.js';

// ── MV3 Service Worker keepalive ─────────────────────────────────────────────
// MV3 SWs are killed after ~30s of inactivity. Alarm every ~24s prevents that.
chrome.alarms.create('sw-keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === 'sw-keepalive') {
    chrome.storage.local.get('_swPing', function () {});
  }
});
