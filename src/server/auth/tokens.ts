/**
 * Opaque token generation and comparison.
 *
 * Every credential the browser holds (session cookie, CSRF token, password-reset link)
 * is a 256-bit random value. The database stores only its SHA-256, so a database dump
 * cannot be replayed as a login.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';

const TOKEN_BYTES = 32;

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two hex digests.
 * A plain `===` on a secret leaks its prefix through timing.
 */
export function safeCompare(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    // Still burn a comparison so the length difference is not itself a fast path.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
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
