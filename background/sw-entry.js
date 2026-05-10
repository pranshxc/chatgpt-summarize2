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

// ── Response.json() empty-body guard ────────────────────────────────────────
// DeepSeek's /api/v0/users/login returns HTTP 202 Accepted with an EMPTY body.
// Calling .json() on an empty response throws:
//   SyntaxError: Failed to execute 'json' on 'Response': Unexpected end of JSON input
// This patch makes .json() return null instead of throwing, so the login flow
// can continue and pick up the session token from the cookies that are already
// correctly captured by auto-save-handler.js.
(function patchResponseJson() {
  var _origJson = Response.prototype.json;
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
