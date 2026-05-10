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
//   2. POST /api/v0/chat_session/create → needs valid Bearer token; ours is fake
//   3. POST /api/v0/chat/completion     → never reached
//
// STRATEGY: own all three endpoints completely. index.js never makes a real
// network call to DeepSeek. deepseekChat() (in auto-save-handler.js) handles
// the real session + completion + streaming internally with proper auth.
//
//   1. Login:   synthetic 200 — gives index.js a non-null user object
//   2. Session: synthetic 200 with a placeholder session ID — index.js passes
//               this ID to the completion call, but we ignore it there anyway
//   3. Completion: extract prompt from body, call deepseekChat(), return
//               synthetic SSE stream with the real response
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
      console.log('[sw-patch] Intercepted login — synthetic 200.');
      return new Response(
        JSON.stringify({ code: 0, data: { user_id: 'patched', token: 'patched' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ── 2. Session create — synthetic 200, no network call ─────────────────
    // deepseekChat() creates its own real session internally, so this session ID
    // is never actually used — index.js just needs a non-null value to proceed.
    if (url.includes('chat.deepseek.com/api/v0/chat_session/create')) {
      console.log('[sw-patch] Intercepted session create — synthetic 200.');
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            biz_data: {
              chat_session: { id: 'patched-session-' + Date.now() }
            }
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ── 3. Completion — run through deepseekChat(), return synthetic SSE ─────
    // deepseekChat() does its own session create + completion with real auth.
    // We extract the prompt from index.js’s request body and pass it through.
    if (url.includes('chat.deepseek.com/api/v0/chat/completion')) {
      console.log('[sw-patch] Intercepted completion — routing through deepseekChat().');
      try {
        var bodyStr = (init && init.body) ? init.body : '{}';
        var bodyObj = {};
        try { bodyObj = JSON.parse(bodyStr); } catch (e) {}

        var chatFn = self.__deepseekChat;
        if (!chatFn) {
          console.error('[sw-patch] __deepseekChat not available — deepseekChat not exposed yet.');
          return new Response(
            JSON.stringify({ code: -1, message: 'DeepSeek chat function not ready.' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
          );
        }

        var result = await chatFn({
          prompt: bodyObj.prompt || '',
          model_type: bodyObj.model_type || 'deepseek_v3',
          thinking_enabled: bodyObj.thinking_enabled || false,
          search_enabled: bodyObj.search_enabled || false,
        });

        console.log('[sw-patch] deepseekChat() succeeded, building SSE stream.');

        // Build synthetic SSE that index.js’s stream parser can consume.
        // The parser looks for: evt.p === 'response/fragments', evt.o === 'APPEND',
        // evt.v = array of { type: 'THINK'|'RESPONSE', content: string }
        // and terminates on any event with click_behavior defined.
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
        console.error('[sw-patch] deepseekChat() failed:', err.message);
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
chrome.alarms.create('sw-keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === 'sw-keepalive') {
    chrome.storage.local.get('_swPing', function () {});
  }
});
