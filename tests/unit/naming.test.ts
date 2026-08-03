import { describe, expect, it } from 'vitest';

import {
  isValidDisplayName,
  MAX_NAME_LENGTH,
  nextAvailableName,
  sanitizeDisplayName,
} from '@/server/domain/naming';

describe('sanitizeDisplayName', () => {
  it('keeps ordinary research folder names untouched', () => {
    expect(sanitizeDisplayName('06_Raw Data')).toBe('06_Raw Data');
    expect(sanitizeDisplayName('qPCR — plate 3 (repeat)')).toBe('qPCR — plate 3 (repeat)');
  });

  it('strips control characters', () => {
    expect(sanitizeDisplayName('Report\u0000\u0007 draft')).toBe('Report draft');
    expect(sanitizeDisplayName('Tabbed\tname')).toBe('Tabbed name');
    expect(sanitizeDisplayName('Line\nbreak')).toBe('Line break');
  });

  it('strips bidirectional overrides that disguise a name', () => {
    // U+202E makes the rest of the string render right-to-left, which is how
    // "report\u202Egnp.exe" appears as "reportexe.png".
    const disguised = 'report\u202Egnp.exe';
    const clean = sanitizeDisplayName(disguised);
    expect(clean).toBe('reportgnp.exe');
    expect(clean).not.toContain('\u202e');
  });

  it('strips isolates and directional marks too', () => {
    expect(sanitizeDisplayName('a\u2066b\u2069c\u200e\u200f')).toBe('abc');
  });

  it('replaces path separators so a name can never be a path', () => {
    expect(sanitizeDisplayName('../../etc/passwd')).toBe('..-..-etc-passwd');
    expect(sanitizeDisplayName('C:\\Windows\\System32')).toBe('C:-Windows-System32');
  });

  it('collapses whitespace and trims', () => {
    expect(sanitizeDisplayName('   spaced    out   ')).toBe('spaced out');
  });

  it('truncates to the maximum length', () => {
    expect(sanitizeDisplayName('x'.repeat(500))).toHaveLength(MAX_NAME_LENGTH);
  });

  it('handles missing input without throwing', () => {
    expect(sanitizeDisplayName(undefined as unknown as string)).toBe('');
  });
});

describe('isValidDisplayName', () => {
  it('rejects empty and reserved names', () => {
    expect(isValidDisplayName('')).toBe(false);
    expect(isValidDisplayName('.')).toBe(false);
    expect(isValidDisplayName('..')).toBe(false);
  });

  it('accepts a normal name', () => {
    expect(isValidDisplayName('Protocols')).toBe(true);
  });
});

describe('nextAvailableName', () => {
  it('returns the original when it is free', () => {
    expect(nextAvailableName('Assays', new Set())).toBe('Assays');
  });

  it('appends a counter, matching what Drive users already expect', () => {
    expect(nextAvailableName('Assays', new Set(['assays']))).toBe('Assays (2)');
    expect(nextAvailableName('Assays', new Set(['assays', 'assays (2)']))).toBe('Assays (3)');
  });

  it('compares case-insensitively', () => {
    expect(nextAvailableName('Assays', new Set(['ASSAYS'.toLowerCase()]))).toBe('Assays (2)');
  });
});
