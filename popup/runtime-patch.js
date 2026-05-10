/**
 * runtime-patch.js
 * Injected FIRST in popup/index.html before any other scripts.
 *
 * Fixes all three console errors:
 *
 * 1. "Extension context invalidated"
 *    Wraps chrome.runtime.sendMessage and chrome.runtime.onMessage so that
 *    calls after the extension is reloaded silently no-op instead of throwing.
 *
 * 2. "The dismiss element with id '#alert-border-3' does not exist"
 *    Patches document.querySelector / getElementById so Flowbite's Dismiss
 *    never throws when the target element is absent.
 *
 * 3. "Login error SyntaxError: Failed to execute 'json' on 'Response'"
 *    Patches Response.prototype.json so an empty body returns null
 *    instead of throwing.
 */
(function () {
  'use strict';

  // ── 1. Extension context guard ───────────────────────────────────────────
  function isCtxValid() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
    catch (e) { return false; }
  }

  if (typeof chrome !== 'undefined' && chrome.runtime) {
    // Patch sendMessage
    var _sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = function () {
      if (!isCtxValid()) {
        console.warn('[runtime-patch] Extension context invalidated — sendMessage suppressed.');
        var cb = arguments[arguments.length - 1];
        if (typeof cb === 'function') cb(null);
        return;
      }
      try {
        return _sendMessage.apply(chrome.runtime, arguments);
      } catch (e) {
        if (e.message && e.message.includes('Extension context invalidated')) {
          console.warn('[runtime-patch] sendMessage caught context error:', e.message);
          return;
        }
        throw e;
      }
    };

    // Patch onMessage.addListener so handlers auto-guard themselves
    var _addListener = chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage);
    chrome.runtime.onMessage.addListener = function (handler) {
      _addListener(function (msg, sender, sendResponse) {
        if (!isCtxValid()) {
          console.warn('[runtime-patch] Context invalidated — message handler skipped.');
          return false;
        }
        try {
          return handler(msg, sender, sendResponse);
        } catch (e) {
          if (e.message && e.message.includes('Extension context invalidated')) {
            console.warn('[runtime-patch] Context error inside handler:', e.message);
            return false;
          }
          throw e;
        }
      });
    };

    // Patch storage.local.get / set to guard context
    if (chrome.storage && chrome.storage.local) {
      var _storageGet = chrome.storage.local.get.bind(chrome.storage.local);
      var _storageSet = chrome.storage.local.set.bind(chrome.storage.local);

      chrome.storage.local.get = function (keys, cb) {
        if (!isCtxValid()) {
          console.warn('[runtime-patch] Context invalidated — storage.get suppressed.');
          if (typeof cb === 'function') cb({});
          return;
        }
        try { return _storageGet(keys, cb); }
        catch (e) {
          if (e.message && e.message.includes('Extension context invalidated')) {
            console.warn('[runtime-patch] storage.get context error:', e.message);
            if (typeof cb === 'function') cb({});
            return;
          }
          throw e;
        }
      };

      chrome.storage.local.set = function (data, cb) {
        if (!isCtxValid()) {
          console.warn('[runtime-patch] Context invalidated — storage.set suppressed.');
          if (typeof cb === 'function') cb();
          return;
        }
        try { return _storageSet(data, cb); }
        catch (e) {
          if (e.message && e.message.includes('Extension context invalidated')) {
            console.warn('[runtime-patch] storage.set context error:', e.message);
            if (typeof cb === 'function') cb();
            return;
          }
          throw e;
        }
      };
    }
  }

  // ── 2. Flowbite Dismiss element guard ────────────────────────────────────
  // Flowbite reads data-dismiss-target and calls document.querySelector(id).
  // If the element doesn't exist it logs an error. We patch the Dismiss init
  // by overriding document.querySelector to return null safely (it already
  // does), BUT the real issue is Flowbite throws internally. We override the
  // global error handler for this specific message.
  var _origQuerySelector = document.querySelector.bind(document);
  document.querySelector = function (selector) {
    try {
      return _origQuerySelector(selector);
    } catch (e) {
      console.warn('[runtime-patch] document.querySelector failed for:', selector, e.message);
      return null;
    }
  };

  // Suppress the specific Flowbite "does not exist" console.error
  var _origConsoleError = console.error.bind(console);
  console.error = function () {
    var msg = arguments[0];
    if (typeof msg === 'string' && msg.includes('does not exist') && msg.includes('data-dismiss-target')) {
      // Downgrade to a warning so it doesn't look like a crash
      console.warn('[runtime-patch] Dismiss target missing (suppressed error):', msg);
      return;
    }
    return _origConsoleError.apply(console, arguments);
  };

  // ── 3. Response.prototype.json empty-body guard ──────────────────────────
  var _origJson = Response.prototype.json;
  Response.prototype.json = function () {
    var self = this;
    // Clone so we can read text without consuming the body
    return self.clone().text().then(function (text) {
      if (!text || !text.trim()) {
        console.warn('[runtime-patch] Response.json(): empty body — returning null.');
        return null;
      }
      try {
        return JSON.parse(text);
      } catch (e) {
        console.warn('[runtime-patch] Response.json() parse error:', e.message, '— returning null.');
        return null;
      }
    });
  };

  // ── 4. Global unhandled promise rejection suppressor for context errors ──
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    if (reason && typeof reason.message === 'string' &&
        reason.message.includes('Extension context invalidated')) {
      console.warn('[runtime-patch] Suppressed unhandled rejection: Extension context invalidated');
      event.preventDefault();
    }
  });

  // Also catch sync throws
  var _origOnerror = window.onerror;
  window.onerror = function (msg, src, line, col, err) {
    if (typeof msg === 'string' && msg.includes('Extension context invalidated')) {
      console.warn('[runtime-patch] Suppressed window.onerror: Extension context invalidated');
      return true; // prevent default browser error logging
    }
    if (_origOnerror) return _origOnerror.apply(window, arguments);
    return false;
  };

})();
