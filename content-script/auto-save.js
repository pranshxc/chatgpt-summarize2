/**
 * auto-save.js  — patched version
 * Wraps chrome.runtime calls with extension-context validity checks so the
 * script does not throw "Extension context invalidated" after an extension
 * reload / update.
 */

"use strict";

// ── Helper: check extension context is still live ────────────────────────────
function _isContextValid() {
  try {
    return !!(chrome && chrome.runtime && chrome.runtime.id);
  } catch (e) {
    return false;
  }
}

// ── Helper: safe storage.local.get ───────────────────────────────────────────
function _safeGet(keys, cb) {
  if (!_isContextValid()) {
    console.warn("[auto-save] Extension context invalidated — storage.get skipped.");
    return cb({});
  }
  try {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        console.warn("[auto-save] storage.get error:", chrome.runtime.lastError.message);
        return cb({});
      }
      cb(result || {});
    });
  } catch (e) {
    console.warn("[auto-save] storage.get threw:", e.message);
    cb({});
  }
}

// ── Helper: safe storage.local.set ───────────────────────────────────────────
function _safeSet(data, cb) {
  if (!_isContextValid()) {
    console.warn("[auto-save] Extension context invalidated — storage.set skipped.");
    return cb && cb();
  }
  try {
    chrome.storage.local.set(data, () => {
      if (chrome.runtime.lastError) {
        console.warn("[auto-save] storage.set error:", chrome.runtime.lastError.message);
      }
      cb && cb();
    });
  } catch (e) {
    console.warn("[auto-save] storage.set threw:", e.message);
    cb && cb();
  }
}

// ── Main auto-save listener ───────────────────────────────────────────────────
function initAutoSave() {
  if (!_isContextValid()) {
    console.warn("[auto-save] Extension context invalidated — auto-save not initialized.");
    return;
  }

  try {
    chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
      // Bail early if context died between event registrations
      if (!_isContextValid()) {
        console.warn("[auto-save] Context invalidated inside onMessage — ignoring.");
        return false;
      }

      if (!message || message.to !== "content-script") return false;

      if (message.type === "AUTO_SAVE") {
        try {
          _safeGet(["autoSaveEnabled"], (result) => {
            if (!result.autoSaveEnabled) return;
            _safeSet({ savedContent: message.data }, () => {
              sendResponse({ ok: true });
            });
          });
          return true; // keep message channel open for async sendResponse
        } catch (e) {
          if (e.message && e.message.includes("Extension context invalidated")) {
            console.warn("[auto-save] Context invalidated during AUTO_SAVE handling.");
            return false;
          }
          throw e;
        }
      }

      return false;
    });
  } catch (e) {
    if (e.message && e.message.includes("Extension context invalidated")) {
      console.warn("[auto-save] Context already invalidated — listener not registered.");
      return;
    }
    throw e;
  }
}

initAutoSave();
