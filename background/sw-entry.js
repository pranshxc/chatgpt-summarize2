// Service Worker entry point
// Import the main bundled SW logic
import './index.js';
// Import auto-save + cookie/message handlers
import './auto-save-handler.js';

// ── MV3 Service Worker keepalive ─────────────────────────────────────────────
// MV3 SWs are killed after ~30 s of inactivity. A periodic alarm prevents that.
chrome.alarms.create('sw-keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === 'sw-keepalive') {
    // Ping storage to keep the SW awake
    chrome.storage.local.get('_swPing', function () {});
  }
});
