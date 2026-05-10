// sw-entry.js — Service Worker entry point (ES module)
// Import order matters: deepseek-pow.js must come before auto-save-handler.js
// because auto-save-handler.js imports getDeepSeekPowHeader from it.
import './index.js';
import './deepseek-pow.js';
import './auto-save-handler.js';

// ── MV3 Service Worker keepalive ──────────────────────────────────────────────
// MV3 SWs are killed after ~30s of inactivity. Alarm every ~24s prevents that.
chrome.alarms.create('sw-keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === 'sw-keepalive') {
    chrome.storage.local.get('_swPing', function () {});
  }
});
