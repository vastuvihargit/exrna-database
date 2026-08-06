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
  it('is deterministic and hides the original value', async () => {
    const token = generateToken();
    const hash = await hashToken(token);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toBe(await hashToken(token));
    expect(hash).not.toContain(token);
  });

  it('gives different hashes for different tokens', async () => {
    expect(await hashToken('a')).not.toBe(await hashToken('b'));
  });

  /**
   * The Cloudflare Phase 1 rewrite moved this from `node:crypto` to WebCrypto. These are
   * the published SHA-256 vectors: they pin the output to the standard rather than to
   * whatever the new implementation happens to produce, which is the only way this test
   * could have caught a wrong-but-self-consistent rewrite.
   */
  it('matches the SHA-256 test vectors', async () => {
    expect(await hashToken('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('safeCompare', () => {
  it('matches identical strings and rejects different ones', async () => {
    const hash = await hashToken('secret');
    expect(safeCompare(hash, hash)).toBe(true);
    expect(safeCompare(hash, await hashToken('other'))).toBe(false);
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
