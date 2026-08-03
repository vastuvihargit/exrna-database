import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  assertSafeKey,
  resolveKey,
  sanitizeFilename,
  extractExtension,
  contentDisposition,
} from '@/server/storage/path-safety';

describe('assertSafeKey', () => {
  it('accepts well-formed generated keys', () => {
    expect(() => assertSafeKey('652f1a2b3c4d5e6f70819200/dept01/file01/version01')).not.toThrow();
    expect(() => assertSafeKey('abc-123_def.456')).not.toThrow();
  });

  // Every one of these is a real traversal payload seen in the wild.
  const traversalPayloads = [
    '../../../etc/passwd',
    '..',
    './secret',
    'a/../../b',
    'a/./b',
    'valid/../../../etc/shadow',
    '....//....//etc/passwd',
    'foo/..%2f..%2fbar',
    '%2e%2e/%2e%2e/etc/passwd',
  ];

  it.each(traversalPayloads)('rejects traversal payload %s', (payload) => {
    expect(() => assertSafeKey(payload)).toThrow();
  });

  const absolutePayloads = [
    '/etc/passwd',
    '/data/storage/originals/x',
    'C:/Windows/System32/config/SAM',
    'c:\\windows\\system32',
    '\\\\server\\share\\file',
    '\\etc\\passwd',
  ];

  it.each(absolutePayloads)('rejects absolute or UNC path %s', (payload) => {
    expect(() => assertSafeKey(payload)).toThrow();
  });

  it('rejects NUL bytes and control characters', () => {
    expect(() => assertSafeKey('file\u0000.txt')).toThrow();
    expect(() => assertSafeKey('file\n.txt')).toThrow();
    expect(() => assertSafeKey('file\r\n.txt')).toThrow();
  });

  it('rejects empty, non-string and oversized keys', () => {
    expect(() => assertSafeKey('')).toThrow();
    expect(() => assertSafeKey(null)).toThrow();
    expect(() => assertSafeKey(undefined)).toThrow();
    expect(() => assertSafeKey(123)).toThrow();
    expect(() => assertSafeKey('a'.repeat(2000))).toThrow();
  });

  it('rejects empty segments and too many segments', () => {
    expect(() => assertSafeKey('a//b')).toThrow();
    expect(() => assertSafeKey('a/b/')).toThrow();
    expect(() => assertSafeKey('/a/b')).toThrow();
    expect(() => assertSafeKey(Array.from({ length: 20 }, (_, i) => `s${i}`).join('/'))).toThrow();
  });

  it('rejects segments that do not start with an alphanumeric', () => {
    expect(() => assertSafeKey('.hidden/file')).toThrow();
    expect(() => assertSafeKey('-flag/file')).toThrow();
    expect(() => assertSafeKey('_private/file')).toThrow();
  });

  it('rejects characters outside the allow-list', () => {
    for (const bad of ['a b', 'a;b', 'a|b', 'a$b', 'a*b', 'a?b', 'a<b', "a'b", 'a"b', 'a\u202eb']) {
      expect(() => assertSafeKey(bad), bad).toThrow();
    }
  });
});

describe('resolveKey', () => {
  const root = path.resolve('/srv/biotech/storage');

  it('resolves a valid key inside the root', () => {
    const resolved = resolveKey(root, 'org1/dept1/file1/v1');
    expect(resolved.startsWith(root)).toBe(true);
    expect(resolved.endsWith(path.join('org1', 'dept1', 'file1', 'v1'))).toBe(true);
  });

  it('never resolves outside the root, whatever the payload', () => {
    for (const payload of ['../outside', '../../etc/passwd', '/etc/passwd', '..']) {
      expect(() => resolveKey(root, payload)).toThrow();
    }
  });

  it('does not treat a sibling directory with the same prefix as inside the root', () => {
    // /srv/biotech/storage-other must not pass a naive startsWith check.
    expect(() => resolveKey(root, '../storage-other/file')).toThrow();
  });
});

describe('sanitizeFilename', () => {
  it('strips directory components', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\me\\secret.xlsx')).toBe('secret.xlsx');
    expect(sanitizeFilename('folder/sub/report.pdf')).toBe('report.pdf');
  });

  it('removes control characters and bidirectional overrides', () => {
    // The classic "invoice<RLO>gnp.exe" display-spoofing trick.
    expect(sanitizeFilename('invoice\u202Egnp.exe')).toBe('invoicegnp.exe');
    expect(sanitizeFilename('bad\u0000name.txt')).toBe('badname.txt');
    expect(sanitizeFilename('line\nbreak.txt')).toBe('linebreak.txt');
  });

  it('replaces filesystem-illegal characters', () => {
    expect(sanitizeFilename('a<b>c:d"e|f?g*h.txt')).toBe('a_b_c_d_e_f_g_h.txt');
  });

  it('neutralises leading dots and trailing dots or spaces', () => {
    expect(sanitizeFilename('.htaccess')).toBe('htaccess');
    expect(sanitizeFilename('report.pdf   ')).toBe('report.pdf');
    expect(sanitizeFilename('report.pdf...')).toBe('report.pdf');
  });

  it('escapes Windows reserved device names', () => {
    expect(sanitizeFilename('CON.txt')).toBe('_CON.txt');
    expect(sanitizeFilename('nul')).toBe('_nul');
    expect(sanitizeFilename('lpt1.dat')).toBe('_lpt1.dat');
  });

  it('falls back to a placeholder when nothing survives', () => {
    expect(sanitizeFilename('')).toBe('untitled');
    expect(sanitizeFilename('...')).toBe('untitled');
    expect(sanitizeFilename('\u0000\u0001')).toBe('untitled');
  });

  it('truncates to 255 bytes while preserving the extension', () => {
    const long = `${'a'.repeat(400)}.fastq`;
    const result = sanitizeFilename(long);
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(255);
    expect(result.endsWith('.fastq')).toBe(true);
  });

  it('preserves ordinary research filenames unchanged', () => {
    expect(sanitizeFilename('EXP-014_HPLC_run3.mzML')).toBe('EXP-014_HPLC_run3.mzML');
    expect(sanitizeFilename('résultats été 2026.pdf')).toBe('résultats été 2026.pdf');
  });
});

describe('extractExtension', () => {
  it('returns a lower-cased extension', () => {
    expect(extractExtension('Report.PDF')).toBe('pdf');
    expect(extractExtension('archive.tar.gz')).toBe('gz');
  });

  it('returns an empty string when there is no usable extension', () => {
    expect(extractExtension('README')).toBe('');
    expect(extractExtension('trailing.')).toBe('');
    expect(extractExtension('.hidden')).toBe('');
  });
});

describe('contentDisposition', () => {
  it('emits both an ASCII fallback and an RFC 5987 encoded name', () => {
    const value = contentDisposition('résumé.pdf', 'attachment');
    expect(value).toContain('attachment; filename="r_sum_.pdf"');
    expect(value).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
  });

  it('prevents header injection through the filename', () => {
    const value = contentDisposition('evil"\r\nSet-Cookie: admin=1.pdf', 'attachment');
    expect(value).not.toContain('\r');
    expect(value).not.toContain('\n');
    expect(value).not.toContain('Set-Cookie: admin=1');
    // The quoted section must not be closable by the payload.
    expect(value.match(/"/g)).toHaveLength(2);
  });
});
