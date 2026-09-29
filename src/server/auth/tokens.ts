/**
 * Opaque token generation and comparison.
 *
 * Every credential the browser holds (session cookie, CSRF token, password-reset link)
 * is a 256-bit random value. The database stores only its SHA-256, so a database dump
 * cannot be replayed as a login.
 *
 * ── Rewritten in Cloudflare Phase 1 to use WebCrypto ────────────────────────────────────
 *
 * Every primitive here is now a web standard (`crypto.getRandomValues`, `crypto.subtle`),
 * which Node 22 and workerd both implement natively. There is deliberately **one**
 * implementation rather than a Node one and a Worker one: two implementations of a security
 * primitive are two things that can disagree, and the one that disagrees silently is the one
 * that accepts a token it should have rejected.
 *
 * `hashToken` is async because `crypto.subtle.digest` is. That is the entire cost of the
 * change, and it is paid at call sites that were already async.
 */

const TOKEN_BYTES = 32;

const HEX = '0123456789abcdef';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += HEX[byte >> 4]! + HEX[byte & 15]!;
  }
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

/**
 * Constant-time comparison of two hex digests.
 * A plain `===` on a secret leaks its prefix through timing.
 *
 * Node's `timingSafeEqual` does not exist in a Worker, so this is the equivalent written
 * out: XOR every byte pair into an accumulator and never return early. The loop runs to the
 * longer of the two lengths, and the length difference is folded into the accumulator rather
 * than short-circuiting — so a mismatched length is not a fast path.
 *
 * Both arguments are always hex digests or opaque tokens of known length, so the length
 * itself is not the secret; what must not leak is how much of a *matching-length* value was
 * correct.
 */
export function safeCompare(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufferA = encoder.encode(a);
  const bufferB = encoder.encode(b);

  let diff = bufferA.length ^ bufferB.length;
  const length = Math.max(bufferA.length, bufferB.length);

  for (let index = 0; index < length; index += 1) {
    diff |= (bufferA[index] ?? 0) ^ (bufferB[index] ?? 0);
  }

  return diff === 0;
}

/** A short, human-readable device label derived from the user agent, for the session list. */
export function describeDevice(userAgent: string): string {
  const ua = userAgent.toLowerCase();

  const browser = ua.includes('edg/')
    ? 'Edge'
    : ua.includes('chrome/') && !ua.includes('chromium')
      ? 'Chrome'
      : ua.includes('firefox/')
        ? 'Firefox'
        : ua.includes('safari/') && !ua.includes('chrome')
          ? 'Safari'
          : 'Browser';

  const platform = ua.includes('windows')
    ? 'Windows'
    : ua.includes('mac os') || ua.includes('macintosh')
      ? 'macOS'
      : ua.includes('android')
        ? 'Android'
        : ua.includes('iphone') || ua.includes('ipad')
          ? 'iOS'
          : ua.includes('linux')
            ? 'Linux'
            : 'Unknown OS';

  return `${browser} on ${platform}`;
}
