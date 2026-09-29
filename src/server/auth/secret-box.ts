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
 *
 * ── Rewritten in Cloudflare Phase 1 to use WebCrypto ────────────────────────────────────
 *
 * `createCipheriv` and `hkdfSync` do not exist in a Worker. This is the same construction
 * expressed with `crypto.subtle`, which Node 22 and workerd both implement natively.
 *
 * **The stored format is unchanged and must stay unchanged**: `v1.iv.tag.ciphertext`, each
 * part base64url, AES-256-GCM, key derived by HKDF-SHA256 from `AUTH_SECRET` with an empty
 * salt and the info string below. A value sealed by the Node build must open in the Worker
 * and vice versa — that is what makes the Phase 7 rollback real rather than theoretical.
 * `tests/security/google-drive-migration.test.ts` asserts the round trip and the rejection
 * of a tampered value; that test is the guard on this file.
 *
 * Note the tag is stored as its own field even though WebCrypto appends it to the
 * ciphertext. Splitting it out on seal and re-joining on open costs nothing and keeps every
 * previously stored value readable.
 */
import { getEnv } from '@/server/config/env';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 'v1';
const HKDF_INFO = 'biotech-drive:secret-box:v1';

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Returns `Uint8Array<ArrayBuffer>` rather than the inferred `Uint8Array<ArrayBufferLike>`.
 * WebCrypto's `BufferSource` excludes `SharedArrayBuffer`, and TypeScript 5.7 enforces that
 * distinction — the annotation is what makes these usable as crypto inputs without a cast.
 */
function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * HKDF-SHA256 over `AUTH_SECRET`, matching the previous `hkdfSync` call exactly: empty salt,
 * the same info string, 256 bits of output.
 *
 * Deliberately not cached. The derivation is cheap next to the I/O that follows every use of
 * it, and a cached `CryptoKey` would outlive a secret rotation the process did not restart for
 * — which is the one situation where a stale key is actively dangerous.
 */
async function derivedKey(): Promise<CryptoKey> {
  const secret = new TextEncoder().encode(getEnv().AUTH_SECRET);

  const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(HKDF_INFO),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function sealSecret(plaintext: string): Promise<string> {
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);

  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: TAG_BYTES * 8 },
      await derivedKey(),
      new TextEncoder().encode(plaintext),
    ),
  );

  // WebCrypto appends the tag; the stored format keeps it in its own field.
  const ciphertext = sealed.subarray(0, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);

  return [VERSION, toBase64Url(iv), toBase64Url(tag), toBase64Url(ciphertext)].join('.');
}

export async function openSecret(sealed: string | null | undefined): Promise<string | null> {
  if (!sealed) return null;

  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;

  try {
    const iv = fromBase64Url(parts[1]!);
    const tag = fromBase64Url(parts[2]!);
    const ciphertext = fromBase64Url(parts[3]!);
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;

    // Re-join what seal split apart: WebCrypto expects the tag appended to the ciphertext.
    const combined = new Uint8Array(new ArrayBuffer(ciphertext.length + tag.length));
    combined.set(ciphertext, 0);
    combined.set(tag, ciphertext.length);

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: TAG_BYTES * 8 },
      await derivedKey(),
      combined,
    );

    return new TextDecoder().decode(plaintext);
  } catch {
    // A tampered value fails the tag check and lands here. Null rather than a throw: the
    // caller's job is to treat "cannot open" as "no usable credential", not to fail a request.
    return null;
  }
}
