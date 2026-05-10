// deepseek-pow.js
// Solves DeepSeek's Proof-of-Work challenge required for /api/v0/chat/completion
//
// Algorithm: DeepSeekHashV1
//   1. GET /api/v0/chat/get_pow_challenge -> { algorithm, challenge, salt, difficulty, signature, target_path }
//   2. Brute-force integer `answer` so SHA-256(salt + String(answer)) has `difficulty` leading zero bits
//   3. base64(JSON({ algorithm, challenge, salt, answer, signature, target_path })) -> x-ds-pow-response header

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
      const mask = (0xff << (8 - remaining)) & 0xff;
      if ((byte & mask) !== 0) return false;
      remaining = 0;
    }
  }
  return true;
}

/**
 * Fetch the PoW challenge from DeepSeek.
 */
async function fetchPowChallenge(token, cookieStr, targetPath) {
  const headers = {
    'Accept': 'application/json',
    'x-app-version': '2.0.0',
    'x-client-platform': 'web',
    'x-client-locale': 'en_GB',
    'x-client-version': '2.0.0',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (cookieStr) headers['Cookie'] = cookieStr;

  const url = `https://chat.deepseek.com/api/v0/chat/get_pow_challenge?target_path=${encodeURIComponent(targetPath)}`;
  const res = await fetch(url, { method: 'GET', headers, credentials: 'omit' });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`PoW challenge fetch failed: HTTP ${res.status} — ${txt.slice(0, 200)}`);
  }
  const json = await res.json();
  const biz = json?.data?.biz_data || json?.data || json;
  if (!biz.challenge || !biz.salt) {
    throw new Error(`Unexpected PoW challenge shape: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return biz;
}

/**
 * Solve the DeepSeekHashV1 PoW challenge.
 * Returns base64-encoded JSON string for x-ds-pow-response header.
 */
async function solvePow(challenge) {
  const { algorithm, challenge: challengeHash, salt, difficulty, signature, target_path } = challenge;

  if (algorithm !== 'DeepSeekHashV1') {
    throw new Error(`Unknown PoW algorithm: ${algorithm}`);
  }

  const encoder = new TextEncoder();
  const requiredBits = typeof difficulty === 'number' ? difficulty : 24;
  const maxAttempts = 10_000_000;

  for (let i = 0; i < maxAttempts; i++) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(salt + String(i)));
    if (hasLeadingZeroBits(new Uint8Array(hashBuffer), requiredBits)) {
      return btoa(JSON.stringify({ algorithm, challenge: challengeHash, salt, answer: i, signature, target_path }));
    }
  }

  throw new Error(`PoW: failed to solve within ${maxAttempts} attempts (difficulty=${requiredBits})`);
}

/**
 * Full PoW pipeline: fetch challenge + solve.
 * Exported for use in auto-save-handler.js.
 */
export async function getDeepSeekPowHeader(token, cookieStr, targetPath) {
  const challenge = await fetchPowChallenge(token, cookieStr, targetPath);
  console.log('[DeepSeek PoW] Challenge fetched, difficulty:', challenge.difficulty, 'salt:', challenge.salt);
  const powHeader = await solvePow(challenge);
  console.log('[DeepSeek PoW] Solved.');
  return powHeader;
}
