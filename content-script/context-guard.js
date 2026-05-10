/**
 * context-guard.js
 * Utility helpers to safely call Chrome extension APIs after context invalidation.
 *
 * Fixes:
 * 1. "Extension context invalidated" errors — wraps all runtime/storage calls
 *    with an isExtensionContextValid() check so stale content scripts fail gracefully.
 * 2. "dismiss element does not exist" — provides a safe dismiss helper that
 *    checks for element existence before acting.
 * 3. "Failed to execute 'json' on 'Response': Unexpected end of JSON input" —
 *    provides a safeResponseJson() helper that guards against empty responses.
 */

"use strict";

/**
 * Returns true when the extension context is still alive.
 * Once the extension is reloaded/updated, chrome.runtime.id becomes undefined
 * and any API call throws "Extension context invalidated".
 */
function isExtensionContextValid() {
  try {
    return !!(chrome && chrome.runtime && chrome.runtime.id);
  } catch (e) {
    return false;
  }
}

/**
 * Wraps chrome.runtime.sendMessage so it silently drops messages when the
 * extension context has been invalidated instead of throwing.
 *
 * @param {*} message
 * @returns {Promise<any>}
 */
function safeSendMessage(message) {
  return new Promise((resolve, reject) => {
    if (!isExtensionContextValid()) {
      console.warn("[context-guard] Extension context invalidated — dropping message:", message);
      return resolve(null);
    }
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          // Suppress "Extension context invalidated" and "message port closed" errors.
          const msg = chrome.runtime.lastError.message || "";
          if (
            msg.includes("Extension context invalidated") ||
            msg.includes("message port closed")
          ) {
            console.warn("[context-guard] Suppressed runtime error:", msg);
            return resolve(null);
          }
          return reject(new Error(msg));
        }
        resolve(response);
      });
    } catch (e) {
      if (e.message && e.message.includes("Extension context invalidated")) {
        console.warn("[context-guard] Extension context invalidated (caught).");
        return resolve(null);
      }
      reject(e);
    }
  });
}

/**
 * Wraps chrome.runtime.onMessage.addListener so the callback first checks
 * context validity before executing.
 *
 * @param {Function} handler  — the normal (message, sender, sendResponse) handler
 */
function safeAddMessageListener(handler) {
  if (!isExtensionContextValid()) return;
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isExtensionContextValid()) {
      console.warn("[context-guard] Context invalidated — skipping message handler.");
      return false;
    }
    try {
      return handler(message, sender, sendResponse);
    } catch (e) {
      if (e.message && e.message.includes("Extension context invalidated")) {
        console.warn("[context-guard] Extension context invalidated inside handler.");
        return false;
      }
      throw e;
    }
  });
}

/**
 * Safe wrapper for chrome.storage.local.get that silently returns {} on
 * context invalidation instead of throwing.
 *
 * @param {string|string[]} keys
 * @returns {Promise<object>}
 */
function safeStorageGet(keys) {
  return new Promise((resolve) => {
    if (!isExtensionContextValid()) {
      console.warn("[context-guard] Extension context invalidated — storage.get skipped.");
      return resolve({});
    }
    try {
      chrome.storage.local.get(keys, (result) => {
        if (chrome.runtime.lastError) {
          console.warn("[context-guard] storage.get error:", chrome.runtime.lastError.message);
          return resolve({});
        }
        resolve(result || {});
      });
    } catch (e) {
      console.warn("[context-guard] storage.get threw:", e.message);
      resolve({});
    }
  });
}

/**
 * Safely parses JSON from a fetch Response.
 * Guards against empty bodies (HTTP 204, network cut-off, etc.) that cause:
 *   "SyntaxError: Failed to execute 'json' on 'Response': Unexpected end of JSON input"
 *
 * @param {Response} response
 * @returns {Promise<object|null>}
 */
async function safeResponseJson(response) {
  try {
    const text = await response.text();
    if (!text || !text.trim()) {
      console.warn("[context-guard] safeResponseJson: empty response body.");
      return null;
    }
    return JSON.parse(text);
  } catch (e) {
    console.error("[context-guard] safeResponseJson parse error:", e.message);
    return null;
  }
}

/**
 * Safely triggers a Flowbite / custom dismiss target.
 * Fixes: "The dismiss element with id '#alert-border-3' does not exist."
 *
 * @param {string} targetId  — CSS selector of the element to dismiss (e.g. "#alert-border-3")
 */
function safeDismiss(targetId) {
  const el = document.querySelector(targetId);
  if (!el) {
    console.warn(`[context-guard] safeDismiss: element "${targetId}" not found — skipping dismiss.`);
    return;
  }
  el.remove();
}

// Export for use in other content-script modules
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    isExtensionContextValid,
    safeSendMessage,
    safeAddMessageListener,
    safeStorageGet,
    safeResponseJson,
    safeDismiss,
  };
}
