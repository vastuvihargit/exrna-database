/**
 * Authenticated encryption for secrets the server must be able to *read back*.
 *
 * Every other credential in this system is hashed, because the server only ever needs to
 * compare it (see `tokens.ts`). A Google refresh token is different: a migration that
 * resumes tomorrow has to present the original value to Google, so it cannot be a hash.
 *
 * AES-256-GCM with a random 96-bit IV per message and the key derived from
 * `AUTH_SECRET` via HKDF under a fixed info string — so this key is not the session key
 * even though it comes from the same root secret. GCM's tag makes the ciphertext
 * tamper-evident: a modified row fails to decrypt rather than yielding altered plaintext.
 *
 * Rotating `AUTH_SECRET` makes existing ciphertexts undecryptable. That is the correct
 * trade: the failure is a migration that must be reconnected, and the alternative is a
 * key that outlives the secret it was derived from.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';
import { getEnv } from '@/server/config/env';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 'v1';

function derivedKey(): Buffer {
  const env = getEnv();
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(env.AUTH_SECRET, 'utf8'), Buffer.alloc(0), 'biotech-drive:secret-box:v1', 32),
  );
}

/** Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function sealSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, derivedKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

/**
 * Returns null rather than throwing on anything malformed or tampered with.
 *
 * The caller's correct response to "this secret cannot be read" is always the same —
 * treat the connection as gone and ask for it again — and an exception here would
 * otherwise surface as a 500 on a page that could have said "reconnect".
 */
export function openSecret(sealed: string | null | undefined): string | null {
  if (!sealed) return null;

  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;

  try {
    const iv = Buffer.from(parts[1]!, 'base64url');
    const tag = Buffer.from(parts[2]!, 'base64url');
    const ciphertext = Buffer.from(parts[3]!, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;

    const decipher = createDecipheriv(ALGORITHM, derivedKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
