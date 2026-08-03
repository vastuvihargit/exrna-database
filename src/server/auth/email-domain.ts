/**
 * Company email domain gate.
 *
 * This is the control that decides who may *sign in at all*. What a signed-in account
 * may *touch* is decided separately by roles and ACLs.
 *
 * The comparison is an exact match on the domain after the final '@'. Using
 * `endsWith` here would accept `alice@company.com.attacker.io`, which is the classic
 * way this check is broken.
 */
export interface EmailParts {
  localPart: string;
  domain: string;
  normalized: string;
}

/** Characters that never belong in a bare mailbox and are used to smuggle a second address. */
const ILLEGAL_CHARS = /[\s<>()[\]\\,;:"]/;
/** Labels of alphanumerics/hyphens, at least two, no leading/trailing hyphen, no empty label. */
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Control characters can truncate an address in a downstream consumer (mail headers,
 * log lines), so they are rejected outright. Checked by code point rather than by a
 * regex literal to keep the source free of unprintable bytes.
 */
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Parses and normalizes an address. Returns null for anything that is not a single
 * plausible mailbox — including addresses with multiple '@', whitespace, or control
 * characters.
 */
export function parseEmail(input: unknown): EmailParts | null {
  if (typeof input !== 'string') return null;

  const value = input.trim().toLowerCase();
  if (value.length === 0 || value.length > 320) return null;
  if (hasControlCharacters(value) || ILLEGAL_CHARS.test(value)) return null;

  const parts = value.split('@');
  if (parts.length !== 2) return null;

  const [localPart, domain] = parts as [string, string];
  if (localPart.length === 0 || localPart.length > 64) return null;
  if (domain.length === 0 || domain.length > 255) return null;
  if (!DOMAIN_PATTERN.test(domain)) return null;

  return { localPart, domain, normalized: value };
}

/** Exact domain match against the configured allow-list. */
export function isCompanyEmail(email: unknown, allowedDomains: readonly string[]): boolean {
  const parsed = parseEmail(email);
  if (!parsed) return false;
  return allowedDomains.some((allowed) => allowed.trim().toLowerCase() === parsed.domain);
}

/** Normalized address, or null when it is not a valid company address. */
export function normalizeCompanyEmail(
  email: unknown,
  allowedDomains: readonly string[],
): string | null {
  const parsed = parseEmail(email);
  if (!parsed) return null;
  return allowedDomains.some((allowed) => allowed.trim().toLowerCase() === parsed.domain)
    ? parsed.normalized
    : null;
}
