import { describe, expect, it } from 'vitest';
import { isCompanyEmail, normalizeCompanyEmail, parseEmail } from '@/server/auth/email-domain';

const DOMAINS = ['company.com', 'subsidiary.com'];

describe('parseEmail', () => {
  it('normalizes case and whitespace', () => {
    expect(parseEmail('  Alice.Smith@Company.COM ')).toEqual({
      localPart: 'alice.smith',
      domain: 'company.com',
      normalized: 'alice.smith@company.com',
    });
  });

  it('rejects addresses that are not a single mailbox', () => {
    for (const bad of ['no-at-sign', 'a@b@c.com', '@company.com', 'alice@', 'alice@com', '']) {
      expect(parseEmail(bad), bad).toBeNull();
    }
  });

  it('rejects non-strings, including NoSQL injection payloads', () => {
    expect(parseEmail({ $ne: null })).toBeNull();
    expect(parseEmail(['alice@company.com'])).toBeNull();
    expect(parseEmail(null)).toBeNull();
    expect(parseEmail(undefined)).toBeNull();
    expect(parseEmail(42)).toBeNull();
  });

  it('rejects header-injection and display-name smuggling attempts', () => {
    expect(parseEmail('alice@company.com\r\nBcc: attacker@evil.com')).toBeNull();
    expect(parseEmail('"Alice" <alice@company.com>')).toBeNull();
    expect(parseEmail('alice@company.com, attacker@evil.com')).toBeNull();
    expect(parseEmail('alice@company.com;attacker@evil.com')).toBeNull();
  });

  it('rejects malformed domains', () => {
    for (const bad of ['a@-company.com', 'a@company-.com', 'a@company..com', 'a@.com', 'a@company.']) {
      expect(parseEmail(bad), bad).toBeNull();
    }
  });
});

describe('company domain gate', () => {
  it('accepts every configured domain', () => {
    expect(isCompanyEmail('alice@company.com', DOMAINS)).toBe(true);
    expect(isCompanyEmail('bob@subsidiary.com', DOMAINS)).toBe(true);
    expect(isCompanyEmail('BOB@SUBSIDIARY.COM', DOMAINS)).toBe(true);
  });

  it('rejects personal email providers', () => {
    for (const email of [
      'alice@gmail.com',
      'alice@outlook.com',
      'alice@yahoo.co.uk',
      'alice@protonmail.com',
    ]) {
      expect(isCompanyEmail(email, DOMAINS), email).toBe(false);
    }
  });

  /**
   * The classic break: an `endsWith`-style check accepts every one of these.
   * The gate must compare the whole domain after the final '@'.
   */
  it('rejects look-alike domains that a suffix check would accept', () => {
    for (const email of [
      'alice@company.com.attacker.io',
      'alice@evilcompany.com',
      'alice@notcompany.com',
      'alice@company.co',
      'alice@company.com.br',
      'alice@sub.company.com',
      'alice@xcompany.com',
    ]) {
      expect(isCompanyEmail(email, DOMAINS), email).toBe(false);
    }
  });

  it('normalizes only when the domain is approved', () => {
    expect(normalizeCompanyEmail(' Alice@Company.com ', DOMAINS)).toBe('alice@company.com');
    expect(normalizeCompanyEmail('alice@gmail.com', DOMAINS)).toBeNull();
    expect(normalizeCompanyEmail({ $ne: null }, DOMAINS)).toBeNull();
  });

  it('is not fooled by extra whitespace or case in the configured list', () => {
    expect(isCompanyEmail('alice@company.com', [' Company.COM '])).toBe(true);
  });

  it('rejects everything when no domains are configured', () => {
    expect(isCompanyEmail('alice@company.com', [])).toBe(false);
  });
});
