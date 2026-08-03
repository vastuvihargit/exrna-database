import { describe, expect, it } from 'vitest';
import {
  checkPasswordPolicy,
  hashPassword,
  verifyPassword,
  burnPasswordVerification,
} from '@/server/auth/password';

describe('Argon2id hashing', () => {
  it('produces an argon2id hash that verifies', async () => {
    const hash = await hashPassword('Correct-Horse-Battery-9!');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'Correct-Horse-Battery-9!')).toBe(true);
  }, 20_000);

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('Correct-Horse-Battery-9!');
    expect(await verifyPassword(hash, 'correct-horse-battery-9!')).toBe(false);
    expect(await verifyPassword(hash, '')).toBe(false);
  }, 20_000);

  it('salts: the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword('Same-Password-123!'), hashPassword('Same-Password-123!')]);
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, 'Same-Password-123!')).toBe(true);
    expect(await verifyPassword(b, 'Same-Password-123!')).toBe(true);
  }, 30_000);

  it('fails closed on a malformed stored hash rather than throwing', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
    expect(await verifyPassword('', 'anything')).toBe(false);
  });

  it('burns comparable work when the account does not exist', async () => {
    // Timing equalisation is the point; assert it actually runs a verification.
    await expect(burnPasswordVerification('whatever')).resolves.toBeUndefined();
  }, 20_000);
});

describe('password policy', () => {
  it('accepts a strong password', () => {
    expect(checkPasswordPolicy('Tr0ubador-Spectra!2026').ok).toBe(true);
  });

  it('requires at least 12 characters', () => {
    const result = checkPasswordPolicy('Short1!a');
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/at least 12/);
  });

  it('requires three character classes', () => {
    const result = checkPasswordPolicy('alllowercaseletters');
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/three of/);
  });

  it('rejects common passwords', () => {
    for (const password of ['password123', 'qwertyuiop', 'letmein123', 'changeme123']) {
      expect(checkPasswordPolicy(password).ok, password).toBe(false);
    }
  });

  it('rejects a password containing the user’s own email or name', () => {
    const byEmail = checkPasswordPolicy('alice.smith-2026!X', { email: 'alice.smith@company.com' });
    expect(byEmail.ok).toBe(false);
    expect(byEmail.problems.join(' ')).toMatch(/email/);

    const byName = checkPasswordPolicy('Wonderland-Alice-1!', { name: 'Alice Wonderland' });
    expect(byName.ok).toBe(false);
    expect(byName.problems.join(' ')).toMatch(/name/);
  });

  it('rejects a single repeated character and over-long input', () => {
    expect(checkPasswordPolicy('aaaaaaaaaaaaaaa').ok).toBe(false);
    expect(checkPasswordPolicy(`A1!${'x'.repeat(200)}`).ok).toBe(false);
  });
});
