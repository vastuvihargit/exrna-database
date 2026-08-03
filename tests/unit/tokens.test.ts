import { describe, expect, it } from 'vitest';
import { describeDevice, generateToken, hashToken, safeCompare } from '@/server/auth/tokens';

describe('token generation', () => {
  it('produces high-entropy, url-safe tokens', () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 random bytes in base64url.
    expect(token.length).toBeGreaterThanOrEqual(42);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => generateToken()));
    expect(tokens.size).toBe(1000);
  });
});

describe('token hashing', () => {
  it('is deterministic and hides the original value', () => {
    const token = generateToken();
    const hash = hashToken(token);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toBe(hashToken(token));
    expect(hash).not.toContain(token);
  });

  it('gives different hashes for different tokens', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
});

describe('safeCompare', () => {
  it('matches identical strings and rejects different ones', () => {
    const hash = hashToken('secret');
    expect(safeCompare(hash, hash)).toBe(true);
    expect(safeCompare(hash, hashToken('other'))).toBe(false);
  });

  it('handles length mismatches without throwing', () => {
    expect(safeCompare('short', 'much-longer-value')).toBe(false);
    expect(safeCompare('', 'x')).toBe(false);
  });
});

describe('describeDevice', () => {
  it('summarizes common user agents', () => {
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36')).toBe(
      'Chrome on Windows',
    );
    expect(describeDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X) Firefox/121.0')).toBe(
      'Firefox on macOS',
    );
    expect(describeDevice('unknown')).toBe('Browser on Unknown OS');
  });
});
