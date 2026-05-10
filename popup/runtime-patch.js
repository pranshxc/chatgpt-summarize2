/**
 * runtime-patch.js
 * Injected FIRST (before index.js module) in popup/index.html.
 *
 * WHY THIS IS NEEDED:
 * Chrome extensions can have their context invalidated when the extension is
 * reloaded/updated while a popup page is still open. Any call to chrome.*
 * APIs after that point throws "Extension context invalidated".
 *
 * IMPORTANT: index.js is a type="module" script. ES modules evaluate
 * synchronously after parsing but AFTER all classic scripts in the same
 * document have run. This means patching chrome.* here (a classic script)
 * takes effect BEFORE the module bundle runs.
 * However, the module bundle captures references like:
 *   const rt = chrome.runtime;   // captured once at module eval time
 * Those captured references still go through the same underlying API object,
 * so patching chrome.runtime.sendMessage on the global still intercepts them.
 *
 * Fixes:
 * 1. Extension context invalidated (sync & async)
 * 2. Flowbite dismiss element missing (#alert-border-3)
 * 3. Response.json() on empty body (Login error)
 */
(function () {
  'use strict';

  // ───────────────────────────────────────────────────────────────────────────
  // HELPER
  // ───────────────────────────────────────────────────────────────────────────
  function isCtxValid() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
    catch (e) { return false; }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 1. chrome.runtime patches
  // ───────────────────────────────────────────────────────────────────────────
  if (typeof chrome !== 'undefined' && chrome.runtime) {

    // --- sendMessage ---
    var _sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = function () {
      if (!isCtxValid()) {
        console.warn('[runtime-patch] Context invalidated — sendMessage suppressed.');
        var lastArg = arguments[arguments.length - 1];
        if (typeof lastArg === 'function') lastArg(undefined);
        return;
      }
      try {
        return _sendMessage.apply(chrome.runtime, arguments);
      } catch (e) {
        if (e.message && e.message.includes('Extension context invalidated')) {
          console.warn('[runtime-patch] sendMessage caught context error.');
          return;
        }
        throw e;
      }
    };

    // --- onMessage.addListener ---
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
            console.warn('[runtime-patch] Context error inside message handler.');
            return false;
          }
          throw e;
        }
      });
    };

    // --- connect (long-lived ports) ---
    if (chrome.runtime.connect) {
      var _connect = chrome.runtime.connect.bind(chrome.runtime);
      chrome.runtime.connect = function () {
        if (!isCtxValid()) {
          console.warn('[runtime-patch] Context invalidated — connect suppressed.');
          // Return a dummy port so callers don’t crash on .postMessage
          return {
            postMessage: function () {},
            disconnect: function () {},
            onMessage: { addListener: function () {}, removeListener: function () {} },
            onDisconnect: { addListener: function () {}, removeListener: function () {} },
          };
        }
        try { return _connect.apply(chrome.runtime, arguments); }
        catch (e) {
          if (e.message && e.message.includes('Extension context invalidated')) {
            console.warn('[runtime-patch] connect caught context error.');
            return { postMessage:function(){}, disconnect:function(){}, onMessage:{addListener:function(){},removeListener:function(){}}, onDisconnect:{addListener:function(){},removeListener:function(){}} };
          }
          throw e;
        }
      };
    }
  }

  // --- chrome.storage ---
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
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
          console.warn('[runtime-patch] storage.get context error.');
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
          console.warn('[runtime-patch] storage.set context error.');
          if (typeof cb === 'function') cb();
          return;
        }
        throw e;
      }
    };
  }

  // --- chrome.downloads (used by auto-save.js) ---
  if (typeof chrome !== 'undefined' && chrome.downloads) {
    var _dlDownload = chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.download = function (options, cb) {
      if (!isCtxValid()) {
        console.warn('[runtime-patch] Context invalidated — downloads.download suppressed.');
        if (typeof cb === 'function') cb();
        return;
      }
      try { return _dlDownload(options, cb); }
      catch (e) {
        if (e.message && e.message.includes('Extension context invalidated')) {
          console.warn('[runtime-patch] downloads.download context error.');
          if (typeof cb === 'function') cb();
          return;
        }
        throw e;
      }
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Unhandled rejection + window.onerror catch-all for context errors
  // ───────────────────────────────────────────────────────────────────────────
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    if (reason && typeof reason.message === 'string' &&
        reason.message.includes('Extension context invalidated')) {
      console.warn('[runtime-patch] Suppressed unhandled rejection: Extension context invalidated');
      event.preventDefault();
    }
  });

  window.addEventListener('error', function (event) {
    if (event.error && typeof event.error.message === 'string' &&
        event.error.message.includes('Extension context invalidated')) {
      console.warn('[runtime-patch] Suppressed error event: Extension context invalidated');
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  var _origOnerror = window.onerror;
  window.onerror = function (msg) {
    if (typeof msg === 'string' && msg.includes('Extension context invalidated')) {
      console.warn('[runtime-patch] Suppressed window.onerror: Extension context invalidated');
      return true;
    }
    if (_origOnerror) return _origOnerror.apply(window, arguments);
    return false;
  };

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Flowbite Dismiss missing-element guard
  // ───────────────────────────────────────────────────────────────────────────
  var _origConsoleError = console.error.bind(console);
  console.error = function () {
    var msg = arguments[0];
    if (typeof msg === 'string' &&
        msg.includes('does not exist') &&
        msg.includes('data-dismiss-target')) {
      console.warn('[runtime-patch] Dismiss target missing (suppressed error):', msg);
      return;
    }
    return _origConsoleError.apply(console, arguments);
  };

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Response.prototype.json empty-body guard
  // ───────────────────────────────────────────────────────────────────────────
  Response.prototype.json = function () {
    return this.clone().text().then(function (text) {
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

})();
