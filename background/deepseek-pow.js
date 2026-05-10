// deepseek-pow.js
// Solves DeepSeek's Proof-of-Work challenge required for /api/v0/chat/completion
//
// Challenge flow (observed from network trace):
//   1. GET /api/v0/chat/get_pow_challenge  -> { algorithm, challenge, salt, difficulty, expire_at, signature, target_path }
//   2. Brute-force nonce so SHA-256(salt + nonce) has `difficulty` leading zero bits
//   3. Encode answer as base64 JSON -> x-ds-pow-response header
//
// DeepSeekHashV1 = SHA-256 of (salt + answer_integer_as_string)
// Target: first `difficulty` bits of digest must be 0
// The observed answer=127655 with challenge starting '4ad81e63...' confirms this pattern.

/**
 * Fetch the PoW challenge from DeepSeek for the given target_path.
 * @param {string} token - Bearer token
 * @param {string} cookieStr - Cookie header string
 * @param {string} targetPath - e.g. '/api/v0/chat/completion'
 * @returns {Promise<object>} challenge object
 */
async function fetchPowChallenge(token, cookieStr, targetPath) {
  const headers = {
    'Accept': 'application/json',
    'Authorization': `Bearer ${token}`,
    'x-app-version': '2.0.0',
    'x-client-platform': 'web',
    'x-client-locale': 'en_GB',
    'x-client-version': '2.0.0',
  };
  if (cookieStr) headers['Cookie'] = cookieStr;

  const url = `https://chat.deepseek.com/api/v0/chat/get_pow_challenge?target_path=${encodeURIComponent(targetPath)}`;
  const res = await fetch(url, { method: 'GET', headers, credentials: 'omit' });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`PoW challenge fetch failed: HTTP ${res.status} — ${txt.slice(0, 200)}`);
  }
  const json = await res.json();
  // Response shape: { code: 0, data: { biz_data: { challenge, salt, difficulty, algorithm, signature, expire_at, target_path } } }
  const biz = json?.data?.biz_data || json?.data || json;
  if (!biz.challenge || !biz.salt) {
    throw new Error(`Unexpected PoW challenge shape: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return biz;
}

/**
 * Solve the DeepSeekHashV1 PoW challenge.
 * Algorithm: find integer `answer` >= 0 such that
 *   SHA-256( salt + String(answer) ) has at least `difficulty` leading zero bits.
 *
 * @param {object} challenge - { algorithm, challenge, salt, difficulty, signature, target_path }
 * @returns {Promise<string>} base64-encoded JSON pow response header value
 */
async function solvePow(challenge) {
  const { algorithm, challenge: challengeHash, salt, difficulty, signature, target_path } = challenge;

  if (algorithm !== 'DeepSeekHashV1') {
    throw new Error(`Unknown PoW algorithm: ${algorithm}`);
  }

  const encoder = new TextEncoder();
  const requiredLeadingZeroBits = difficulty || 24; // default observed: varies, ~20-28

  let answer = 0;
  const maxAttempts = 10_000_000;

  for (let i = 0; i < maxAttempts; i++) {
    const input = salt + String(i);
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(input));
    const hashBytes = new Uint8Array(hashBuffer);

    if (hasLeadingZeroBits(hashBytes, requiredLeadingZeroBits)) {
      answer = i;
      const powResponse = {
        algorithm,
        challenge: challengeHash,
        salt,
        answer,
        signature,
        target_path,
      };
      return btoa(JSON.stringify(powResponse));
    }
  }

  throw new Error(`PoW: could not solve challenge within ${maxAttempts} attempts (difficulty=${requiredLeadingZeroBits})`);
}

/**
 * Check if the first `n` bits of a Uint8Array are all zero.
 */
function hasLeadingZeroBits(bytes, n) {
  let remaining = n;
  for (let i = 0; i < bytes.length && remaining > 0; i++) {
    const byte = bytes[i];
    if (remaining >= 8) {
      if (byte !== 0) return false;
      remaining -= 8;
    } else {
      // Check the top `remaining` bits of this byte
      const mask = 0xff << (8 - remaining) & 0xff;
      if ((byte & mask) !== 0) return false;
      remaining = 0;
    }
  }
  return true;
}

/**
 * Full PoW pipeline: fetch challenge + solve it.
 * Returns the base64 string ready to put in x-ds-pow-response header.
 */
async function getDeepSeekPowHeader(token, cookieStr, targetPath) {
  const challenge = await fetchPowChallenge(token, cookieStr, targetPath);
  console.log('[DeepSeek PoW] Challenge fetched, difficulty:', challenge.difficulty, 'salt:', challenge.salt);
  const powHeader = await solvePow(challenge);
  console.log('[DeepSeek PoW] Solved. Answer encoded.');
  return powHeader;
}
