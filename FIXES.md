# Bug Fixes

## Extension Errors Fixed

### 1. `Uncaught Error: Extension context invalidated` / `Uncaught (in promise) Error: Extension context invalidated`

**Root cause:** When a Chrome extension is reloaded or updated, the extension context for already-injected content scripts becomes invalid. Any call to `chrome.runtime.*` or `chrome.storage.*` after this point throws `"Extension context invalidated"`.

**Fix:** Added `content-script/context-guard.js` — a utility module that:
- Exports `isExtensionContextValid()` to check liveness before any API call.
- Exports `safeSendMessage()`, `safeAddMessageListener()`, and `safeStorageGet()` wrappers that silently no-op / log a warning when the context is dead instead of throwing.

`content-script/auto-save.js` was also rewritten to use these guards around every `chrome.runtime` and `chrome.storage` call.

**Usage in new/existing scripts:**
```js
const { isExtensionContextValid, safeSendMessage, safeStorageGet } = require('./context-guard');

// Before sending any runtime message:
if (isExtensionContextValid()) {
  safeSendMessage({ type: 'MY_ACTION' });
}
```

---

### 2. `The dismiss element with id "#alert-border-3" does not exist`

**Root cause:** The Flowbite (or custom) dismiss handler tries to call `.remove()` on a DOM element that may not have rendered yet, or has already been removed.

**Fix:** `context-guard.js` exports `safeDismiss(targetId)` which checks for element existence via `document.querySelector(targetId)` before acting, and logs a warning instead of throwing when the element is absent.

**Usage:**
```js
import { safeDismiss } from './context-guard';
// Instead of: new Dismiss(document.getElementById('alert-border-3'))
safeDismiss('#alert-border-3');
```

---

### 3. `Login error SyntaxError: Failed to execute 'json' on 'Response': Unexpected end of JSON input`

**Root cause:** A `fetch()` response with an empty body (HTTP 204 No Content, network interruption, or server error without body) is passed directly to `.json()`, which throws on empty input.

**Fix:** `context-guard.js` exports `safeResponseJson(response)` which first reads the body as text, checks for emptiness, and only then parses JSON — returning `null` on failure instead of throwing.

**Usage:**
```js
import { safeResponseJson } from './context-guard';

const response = await fetch('/api/login', { method: 'POST', body: ... });
const data = await safeResponseJson(response); // never throws
if (!data) {
  // handle empty/error response gracefully
}
```

---

## Files Changed

| File | Change |
|------|--------|
| `content-script/context-guard.js` | **New** — shared guard utilities |
| `content-script/auto-save.js` | **Rewritten** — uses context guards throughout |
| `FIXES.md` | **New** — this document |
