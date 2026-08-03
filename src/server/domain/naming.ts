/**
 * Display-name hygiene for folders, files and projects.
 *
 * Separate from `storage/path-safety.sanitizeFilename`, which protects the *filesystem*.
 * This protects the *reader*: a name can render as something other than what it is.
 * A right-to-left override (U+202E) placed before "gnp.exe" displays as "exe.png", which
 * is a social-engineering vector even when the bytes never reach a disk.
 *
 * Filtering by code point rather than by a regex with literal control characters keeps
 * the ranges readable and reviewable — an invisible character inside a character class
 * is exactly the kind of thing that gets silently mangled by an editor.
 */

const CONTROL_END = 0x1f;
const DELETE = 0x7f;
const BIDI_OVERRIDE_START = 0x202a; // LRE, RLE, PDF, LRO, RLO
const BIDI_OVERRIDE_END = 0x202e;
const BIDI_ISOLATE_START = 0x2066; // LRI, RLI, FSI, PDI
const BIDI_ISOLATE_END = 0x2069;
const LTR_MARK = 0x200e;
const RTL_MARK = 0x200f;

/**
 * Tab, newline, carriage return, form feed and vertical tab are control characters but
 * they are also *whitespace*: a pasted name that spans two lines means "one space", not
 * two words run together. They become spaces; everything else in the range is removed.
 */
const WHITESPACE_CONTROLS = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d]);

function isUnsafeCodePoint(codePoint: number): boolean {
  if (WHITESPACE_CONTROLS.has(codePoint)) return false;
  if (codePoint <= CONTROL_END || codePoint === DELETE) return true;
  if (codePoint >= BIDI_OVERRIDE_START && codePoint <= BIDI_OVERRIDE_END) return true;
  if (codePoint >= BIDI_ISOLATE_START && codePoint <= BIDI_ISOLATE_END) return true;
  return codePoint === LTR_MARK || codePoint === RTL_MARK;
}

/** Path separators must never appear: a name is one segment, never a path. */
const SEPARATORS = /[/\\]/g;

export const MAX_NAME_LENGTH = 200;

export function sanitizeDisplayName(input: string): string {
  const stripped = [...String(input ?? '')]
    .filter((character) => !isUnsafeCodePoint(character.codePointAt(0) ?? 0))
    .join('');

  return stripped
    .replace(SEPARATORS, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

/** `.` and `..` would be ambiguous in every breadcrumb and export path. */
const RESERVED_NAMES = new Set(['.', '..']);

export function isValidDisplayName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_NAME_LENGTH && !RESERVED_NAMES.has(name);
}

/**
 * Produces "Protocols (2)" when "Protocols" is taken — the shape Drive users already
 * expect from a copy or an import collision. `taken` holds lower-cased names.
 */
export function nextAvailableName(base: string, taken: Set<string>): string {
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} (${Date.now()})`;
}
