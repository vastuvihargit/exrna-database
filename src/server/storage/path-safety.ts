/**
 * Path safety — the single chokepoint that prevents directory traversal.
 *
 * Every provider method resolves its key through `resolveKey`. The design is an
 * allow-list (only these characters, only these segment shapes) rather than a
 * deny-list, because deny-lists lose to encoding tricks: `..`, `%2e%2e`, `....//`,
 * `..\\`, UNC paths, NUL bytes and unicode separators all simply fail to match.
 *
 * Two independent checks run for every key:
 *   1. structural validation of the key itself (assertSafeKey)
 *   2. a resolved-prefix containment check against the area root (defence in depth)
 */
import path from 'path';
import { StorageError } from '@/server/errors/app-error';

/** One path segment: starts alphanumeric, then alphanumerics, dot, dash, underscore. */
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const MAX_KEY_LENGTH = 1024;
const MAX_SEGMENTS = 16;

export function assertSafeKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new StorageError('INVALID_KEY', 'Storage key must be a non-empty string');
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new StorageError('INVALID_KEY', 'Storage key exceeds the maximum length');
  }
  // NUL and other control characters truncate paths in some syscalls.
  if (/[\u0000-\u001f\u007f]/.test(key)) {
    throw new StorageError('INVALID_KEY', 'Storage key contains control characters');
  }
  // Absolute POSIX paths, Windows drive letters and UNC paths are never valid keys.
  if (key.startsWith('/') || key.startsWith('\\') || /^[A-Za-z]:/.test(key)) {
    throw new StorageError('INVALID_KEY', 'Storage key must be relative');
  }
  if (key.includes('\\')) {
    throw new StorageError('INVALID_KEY', 'Storage key must use forward slashes');
  }

  const segments = key.split('/');
  if (segments.length > MAX_SEGMENTS) {
    throw new StorageError('INVALID_KEY', 'Storage key has too many segments');
  }
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new StorageError('INVALID_KEY', 'Storage key contains an invalid path segment');
    }
    if (!SEGMENT_PATTERN.test(segment)) {
      throw new StorageError('INVALID_KEY', 'Storage key contains disallowed characters');
    }
  }
}

/**
 * Resolve a relative key inside a root directory.
 * Throws PATH_ESCAPE if the result would land outside the root — this can only happen
 * if assertSafeKey were ever weakened, which is exactly why the check is kept.
 */
export function resolveKey(root: string, key: string): string {
  assertSafeKey(key);

  const resolvedRoot = path.resolve(root);
  const fullPath = path.resolve(resolvedRoot, key);
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;

  if (fullPath !== resolvedRoot && !fullPath.startsWith(prefix)) {
    throw new StorageError('PATH_ESCAPE', 'Resolved storage path escaped its root');
  }
  return fullPath;
}

/** Windows device names that are unusable as filenames even with an extension. */
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * Sanitize a user-supplied filename.
 *
 * The result is used for DISPLAY and for Content-Disposition only — never as a physical
 * filename (those are always generated UUIDs). Removing path separators, control
 * characters and bidirectional overrides prevents both traversal and the
 * "invoice\u202Egnp.exe" homograph trick.
 */
export function sanitizeFilename(input: string): string {
  let name = String(input ?? '');

  // Strip any directory component a browser or API client may have included.
  name = name.replace(/\\/g, '/');
  const lastSlash = name.lastIndexOf('/');
  if (lastSlash >= 0) name = name.slice(lastSlash + 1);

  // Control characters, bidi overrides, and characters illegal on common filesystems.
  name = name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();

  // A leading dot would create a hidden file; trailing dots/spaces are stripped by Windows.
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, '');

  if (name.length === 0) name = 'untitled';

  const dotIndex = name.lastIndexOf('.');
  const stem = dotIndex > 0 ? name.slice(0, dotIndex) : name;
  const ext = dotIndex > 0 ? name.slice(dotIndex) : '';

  if (WINDOWS_RESERVED.has(stem.toLowerCase())) {
    name = `_${name}`;
  }

  // Truncate to 255 bytes while keeping the extension intact.
  const encoder = new TextEncoder();
  if (encoder.encode(name).length > 255) {
    const extBytes = encoder.encode(ext).length;
    let truncated = stem;
    while (encoder.encode(truncated).length > 255 - extBytes - 1) {
      truncated = truncated.slice(0, -1);
    }
    name = truncated + ext;
  }

  return name;
}

/** Lower-cased extension without the dot, or '' when the filename has none. */
export function extractExtension(filename: string): string {
  const sanitized = sanitizeFilename(filename);
  const dotIndex = sanitized.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === sanitized.length - 1) return '';
  return sanitized.slice(dotIndex + 1).toLowerCase();
}

/**
 * Build an RFC 6266 / RFC 5987 Content-Disposition value.
 *
 * CR/LF/quote stripping in the ASCII fallback is what prevents response-header
 * injection through a crafted filename.
 */
export function contentDisposition(filename: string, type: 'inline' | 'attachment'): string {
  const safe = sanitizeFilename(filename);
  const ascii = safe
    // Anything outside printable ASCII becomes '_' in the fallback name.
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\;\r\n]/g, '_');
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
