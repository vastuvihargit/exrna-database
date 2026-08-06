/**
 * Password hashing (Argon2id) and policy.
 *
 * Parameters follow OWASP's Argon2id guidance: 64 MiB memory, 3 iterations,
 * 1 degree of parallelism. Memory cost is the parameter that actually resists GPU
 * cracking, so it is the one that must not be lowered casually.
 */
// Imported through the `@/` alias, not as `./argon2-binding`. NormalModuleReplacementPlugin
// matches the *request string* rather than the resolved path, so the specifier has to carry
// the directories the pattern in next.config.ts looks for.
import { hash, verify } from '@/server/auth/argon2-binding';

/**
 * `algorithm` is left at the library default, which is Argon2id. Naming the enum
 * member explicitly is not possible here: it is an ambient const enum, which
 * `isolatedModules` (required by Next.js) forbids importing as a value.
 */
const ARGON2_OPTIONS = {
  memoryCost: 65_536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
} as const;

/**
 * A pre-computed hash of a random value, used to burn the same CPU time when the
 * account does not exist. Without it, "unknown user" returns measurably faster than
 * "wrong password" and the login endpoint becomes an account-enumeration oracle.
 */
let dummyHash: string | null = null;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain, ARGON2_OPTIONS);
  } catch {
    // A malformed or truncated hash must fail closed, not throw into the route.
    return false;
  }
}

/** Runs a real verification against a throwaway hash to equalise response timing. */
export async function burnPasswordVerification(plain: string): Promise<void> {
  dummyHash ??= await hashPassword('argon2id-timing-equalisation-placeholder');
  await verifyPassword(dummyHash, plain);
}

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * A short deny-list of passwords that appear at the top of every breach corpus.
 * This is not a substitute for a full breach-corpus check (Phase 11) — it is the
 * cheap 80% that stops the worst choices at signup time.
 */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd', 'p@ssw0rd', 'p@ssword123',
  'qwerty', 'qwerty123', 'qwertyuiop', '123456', '1234567890', '12345678901',
  'letmein', 'letmein123', 'welcome', 'welcome123', 'admin', 'administrator',
  'iloveyou', 'monkey', 'dragon', 'sunshine', 'princess', 'football', 'baseball',
  'abc123', 'abcd1234', 'trustno1', 'changeme', 'changeme123', 'secret', 'passw0rd123',
  'biotech', 'research', 'laboratory', 'science123',
]);

export interface PasswordPolicyResult {
  ok: boolean;
  problems: string[];
}

/**
 * Validates a password against length, composition, the common-password list, and the
 * user's own identity. Checking against name/email matters because "FirstnameLastname1"
 * is exactly what people pick and exactly what a targeted attacker tries first.
 */
export function checkPasswordPolicy(
  password: string,
  context?: { email?: string; name?: string },
): PasswordPolicyResult {
  const problems: string[] = [];

  if (password.length < PASSWORD_MIN_LENGTH) {
    problems.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    problems.push(`Password must be at most ${PASSWORD_MAX_LENGTH} characters`);
  }

  const lower = password.toLowerCase();

  if (COMMON_PASSWORDS.has(lower)) {
    problems.push('This password is too common');
  }

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) {
    problems.push('Password must combine at least three of: lower case, upper case, digits, symbols');
  }

  if (/^(.)\1+$/.test(password)) {
    problems.push('Password must not be a single repeated character');
  }

  if (context?.email) {
    const localPart = context.email.split('@')[0]?.toLowerCase() ?? '';
    if (localPart.length >= 3 && lower.includes(localPart)) {
      problems.push('Password must not contain your email address');
    }
  }

  if (context?.name) {
    for (const part of context.name.toLowerCase().split(/\s+/)) {
      if (part.length >= 3 && lower.includes(part)) {
        problems.push('Password must not contain your name');
        break;
      }
    }
  }

  return { ok: problems.length === 0, problems };
}
