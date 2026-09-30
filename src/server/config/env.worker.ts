/**
 * Environment validation for the Cloudflare Worker runtime.
 *
 * `env.ts` is the Node deployment's contract and stays exactly as it is. This is the
 * Worker's, and it differs in three ways that all follow from the runtime rather than from
 * preference:
 *
 *   1. **No storage roots.** `LOCAL_STORAGE_ROOT` and its five siblings describe directories
 *      on a disk. A Worker has no disk. Requiring them would mean inventing six paths that
 *      can never be opened, and `assertRootsArePrivate()` — which exists to stop file storage
 *      landing inside the publicly served directory — would be validating nothing.
 *
 *   2. **Google Drive is mandatory, not optional.** On Node, Drive is a flag-gated secondary
 *      provider and `local` is the default. In a Worker there is no second option: if Drive
 *      is not configured, no file can be read at all. So the checks that `env.ts` applies
 *      only when `GOOGLE_DRIVE_STORAGE_ENABLED` is true are unconditional here.
 *
 *   3. **Bindings are validated, not just variables.** A missing `DB` binding is a
 *      deployment error that should surface at boot with a sentence explaining it, not as
 *      `undefined is not a function` inside a repository three requests later.
 *
 * The variable *names* are the ones the brief specifies (`GOOGLE_SERVICE_ACCOUNT_EMAIL`,
 * `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`), and they are accepted alongside the longer
 * `GOOGLE_DRIVE_*` names the Node deployment already uses, so one `.env` can feed both
 * during the transition.
 */
import { z } from 'zod';
/**
 * Imported as types rather than pulled in globally. Adding `@cloudflare/workers-types` to
 * `tsconfig.json`'s `types` array would redefine `fetch`, `Request` and `Response` for the
 * whole project, including the 118 Next.js route handlers that are typed against the DOM
 * lib — which produces hundreds of spurious errors and hides real ones.
 */
import type { D1Database, DurableObjectNamespace, Queue } from '@cloudflare/workers-types';
import {
  assertDataSourceMatrix,
  envVarFor,
  workerReadinessGaps,
} from '@/server/repositories/data-source';
import { assertAccessConfigured } from '@/server/auth/cloudflare-access';
import { AUTH_PROVIDERS, signInConfigIssues } from '@/server/auth/auth-provider';

const bool = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? defaultValue : v === 'true' || v === '1'));

const int = (defaultValue: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? defaultValue : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const domainList = z
  .string()
  .min(1, 'COMPANY_EMAIL_DOMAINS must list at least one domain')
  .transform((v) =>
    v
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  )
  .refine((list) => list.length > 0, 'COMPANY_EMAIL_DOMAINS must list at least one domain');

const workerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('production'),
  APP_URL: z.string().url().default('http://localhost:8787'),
  APP_NAME: z.string().default('Biotech Research Drive'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),

  COMPANY_EMAIL_DOMAINS: domainList,

  // Google Shared Drive — the only storage a Worker has.
  GOOGLE_SHARED_DRIVE_ID: z.string().min(1, 'GOOGLE_SHARED_DRIVE_ID is required'),
  GOOGLE_DRIVE_ROOT_FOLDER_ID: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().min(1, 'GOOGLE_SERVICE_ACCOUNT_EMAIL is required'),
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: z
    .string()
    .min(1, 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY is required'),
  GOOGLE_WORKSPACE_DOMAIN: z.string().min(1, 'GOOGLE_WORKSPACE_DOMAIN is required'),

  /**
   * Where uploads are staged. In a Worker there is exactly one possible answer.
   *
   * A literal rather than an enum with a default: `local` staging streams to a filesystem that
   * does not exist here, so accepting the value and failing later would turn a configuration
   * mistake into a run of failed uploads. It is stated in `wrangler.jsonc` under `vars` so the
   * deployed configuration says so out loud rather than relying on a default.
   *
   * The shared `env.ts` schema — which the storage layer actually reads, because both runtimes
   * read `process.env` — defaults this to `local`. That default is right for the Node
   * deployment and wrong here, which is exactly why this is checked at boot.
   */
  UPLOAD_STAGING: z.literal('google_drive', {
    errorMap: () => ({
      message:
        'must be "google_drive" in a Worker: workerd has no persistent filesystem, so uploads ' +
        'cannot be staged on local disk. Set it in wrangler.jsonc under "vars".',
    }),
  }),
  DEFAULT_STORAGE_PROVIDER: z.literal('google_drive', {
    errorMap: () => ({
      message:
        'must be "google_drive" in a Worker: there is no local object store to record new ' +
        'content against.',
    }),
  }),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  /**
   * Malware scanning has to be *decided* in a Worker: there is no default.
   *
   * `clamav` is impossible (clamd needs a raw TCP socket), so the choice is the HTTP boundary or
   * an explicit `disabled`. A Worker with neither refuses to boot — the alternative is a
   * deployment that stores unscanned files because nobody got round to choosing, which is the
   * silent version of a decision that should be made out loud.
   */
  MALWARE_SCAN_MODE: z.enum(['disabled', 'http'], {
    errorMap: () => ({
      message:
        'must be set to "http" (with MALWARE_SCAN_ENDPOINT and MALWARE_SCAN_SECRET) or, as an ' +
        'explicit and logged decision, "disabled". clamav cannot run in a Worker.',
    }),
  }),
  MALWARE_SCAN_ENDPOINT: z.string().url().optional(),
  MALWARE_SCAN_SECRET: z.string().optional(),

  /**
   * The sign-in front door (`auth/auth-provider.ts`). `google_oauth` needs the OAuth client and
   * no Access; otherwise Access is required in production, as before.
   */
  AUTH_PROVIDER: z.enum(AUTH_PROVIDERS).optional(),

  // Cloudflare Access. Required in production unless AUTH_PROVIDER is "google_oauth".
  CF_ACCESS_TEAM_DOMAIN: z.string().optional(),
  CF_ACCESS_AUD: z.string().optional(),

  /** The cutover window: off | read_only | maintenance. See runtime/maintenance.ts. */
  MAINTENANCE_MODE: z.enum(['off', 'read_only', 'maintenance']).default('off'),

  MAX_UPLOAD_SIZE_MB: int(2048, 1, 1024 * 1024),
  SESSION_IDLE_TIMEOUT_MINUTES: int(480, 5),
  SESSION_ABSOLUTE_TIMEOUT_MINUTES: int(720, 5),
  TRASH_RETENTION_DAYS: int(30, 1),

  GOOGLE_DRIVE_UPLOAD_CHUNK_MB: int(16, 1, 512),
  GOOGLE_DRIVE_MAX_CONCURRENT_TRANSFERS: int(4, 1, 32),
  GOOGLE_DRIVE_REQUEST_TIMEOUT_MS: int(120_000, 1000, 900_000),
  GOOGLE_DRIVE_NATIVE_EDITOR_ENABLED: bool(false),
  DRIVE_SYNC_INTERVAL_MINUTES: int(15, 1, 1440),
});

export type RawWorkerEnv = z.infer<typeof workerEnvSchema>;

const MB = 1024 ** 2;

export interface WorkerEnv extends RawWorkerEnv {
  isProduction: boolean;
  isDevelopment: boolean;
  isTest: boolean;
  maxUploadBytes: number;
  googleDriveUploadChunkBytes: number;
  /** Always `google_drive` in a Worker. Present so shared code can read it uniformly. */
  storageProvider: 'google_drive';
}

/**
 * The bindings declared in `wrangler.jsonc`. There is no workflow binding: the Mongo → D1
 * migration runs from an operator machine, not as a Cloudflare Workflow.
 */
export interface WorkerBindings {
  DB: D1Database;
  SYNC_QUEUE: Queue;
  NOTIFICATION_QUEUE: Queue;
  RATE_LIMITER: DurableObjectNamespace;
}

// RATE_LIMITER: without it sign-in and API limits would count per isolate — not a limit at all.
const REQUIRED_BINDINGS = ['DB', 'SYNC_QUEUE', 'NOTIFICATION_QUEUE', 'RATE_LIMITER'] as const;

export function assertBindings(source: Record<string, unknown>): WorkerBindings {
  const missing = REQUIRED_BINDINGS.filter((name) => source[name] === undefined);

  if (missing.length > 0) {
    throw new Error(
      `Missing Cloudflare bindings: ${missing.join(', ')}.\n\n` +
        'These are declared in wrangler.jsonc. If this is a local run, check that you are ' +
        'using `npm run cf:preview` rather than plain `wrangler dev`, and that the D1 ' +
        'database has been created with `npx wrangler d1 create`.',
    );
  }

  return source as unknown as WorkerBindings;
}

/**
 * Accepts either the brief's variable names or the longer ones the Node deployment uses, so
 * a single secret store can serve both runtimes while the two run side by side.
 */
function withAliases(source: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    ...source,
    GOOGLE_SERVICE_ACCOUNT_EMAIL:
      source.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? source.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL,
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY:
      source.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ?? source.GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY,
    // The sign-in OAuth client: the Worker is configured with the GOOGLE_OAUTH_* names.
    GOOGLE_CLIENT_ID: source.GOOGLE_CLIENT_ID ?? source.GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: source.GOOGLE_CLIENT_SECRET ?? source.GOOGLE_OAUTH_CLIENT_SECRET,
  };
}

let cached: WorkerEnv | null = null;

export function loadWorkerEnv(source: Record<string, string | undefined>): WorkerEnv {
  const parsed = workerEnvSchema.safeParse(withAliases(source));

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid Worker environment configuration:\n${issues}\n\n` +
        'Plain values go in wrangler.jsonc under "vars". Secrets go in .dev.vars locally, ' +
        'and `npx wrangler secret put <NAME> --env <environment>` remotely. See ' +
        '.dev.vars.example for the full list.',
    );
  }

  const v = parsed.data;

  if (v.SESSION_ABSOLUTE_TIMEOUT_MINUTES < v.SESSION_IDLE_TIMEOUT_MINUTES) {
    throw new Error(
      'Invalid Worker environment configuration:\n' +
        '  • SESSION_ABSOLUTE_TIMEOUT_MINUTES: must be >= SESSION_IDLE_TIMEOUT_MINUTES',
    );
  }

  if (v.NODE_ENV === 'production' && v.APP_URL.startsWith('http://')) {
    throw new Error(
      'Invalid Worker environment configuration:\n' +
        '  • APP_URL: must use https:// in production',
    );
  }

  if (v.NODE_ENV === 'production' && v.AUTH_SECRET === v.SESSION_SECRET) {
    throw new Error(
      'Invalid Worker environment configuration:\n' +
        '  • SESSION_SECRET: AUTH_SECRET and SESSION_SECRET must differ in production',
    );
  }

  // Half an Access configuration reads as "not configured" to `accessConfigFrom`, which outside
  // production would silently mean "no Access check". Refused here instead, in every environment.
  if (Boolean(v.CF_ACCESS_TEAM_DOMAIN?.trim()) !== Boolean(v.CF_ACCESS_AUD?.trim())) {
    throw new Error(
      'Invalid Worker environment configuration:\n' +
        '  • CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD: must be set together, or neither',
    );
  }

  if (v.MALWARE_SCAN_MODE === 'http') {
    const problems: string[] = [];
    if (!v.MALWARE_SCAN_ENDPOINT) problems.push('MALWARE_SCAN_ENDPOINT: is required when MALWARE_SCAN_MODE is "http"');
    else if (v.NODE_ENV === 'production' && !v.MALWARE_SCAN_ENDPOINT.startsWith('https://')) {
      problems.push('MALWARE_SCAN_ENDPOINT: must use https:// in production');
    }
    if (!v.MALWARE_SCAN_SECRET || v.MALWARE_SCAN_SECRET.length < 16) {
      problems.push('MALWARE_SCAN_SECRET: must be at least 16 characters when MALWARE_SCAN_MODE is "http"');
    }
    if (problems.length > 0) {
      throw new Error(`Invalid Worker environment configuration:\n${problems.map((p) => `  • ${p}`).join('\n')}`);
    }
  }

  // A split that puts a foreign key across two databases. Same check the Node deployment runs,
  // for the same reason: at startup, not on somebody's upload.
  assertDataSourceMatrix();

  /**
   * A production Worker with no identity provider cannot authenticate anybody.
   *
   * `@node-rs/argon2` is a native addon workerd cannot load, so the existing `passwordHash`
   * values are unverifiable there by any means — `shims/argon2.worker.ts` refuses rather than
   * substituting a different algorithm, which would reject every correct password. Identity
   * therefore comes from Access or, with `AUTH_PROVIDER=google_oauth`, from Google sign-in, and
   * booting with neither produces a deployment that 401s every request while looking healthy.
   */
  const signInIssues = signInConfigIssues(v);
  if (signInIssues.length > 0) {
    throw new Error(
      'Invalid Worker environment configuration:\n' +
        signInIssues.map((issue) => `  • ${issue.path}: ${issue.message}`).join('\n'),
    );
  }
  // In `google_oauth` mode identity comes from a verified Google ID token instead, and the
  // check above has already required the OAuth client and refused a half-Access configuration.
  if (v.AUTH_PROVIDER !== 'google_oauth') assertAccessConfigured(v, v.NODE_ENV === 'production');

  /**
   * In a Worker, every module must be on D1 — and in production that is an error, not a warning.
   *
   * A Worker cannot open the TCP socket Mongoose needs, so a module left on `mongo` is not a
   * slower path: it throws the first time anything touches it. Discovering that per module, in
   * production, from user reports, is the failure this check exists to prevent.
   *
   * Left as a warning outside production so `cf:preview` can boot with a partial flag set,
   * which is how each module was verified in a Worker as it landed.
   */
  const gaps = workerReadinessGaps();
  if (gaps.length > 0) {
    const detail = gaps.map((module) => `${envVarFor(module)}=d1`).join(', ');
    if (v.NODE_ENV === 'production') {
      throw new Error(
        'Invalid Worker environment configuration:\n' +
          `  • These modules are still routed to MongoDB, which a Worker cannot reach: ${detail}`,
      );
    }
    console.warn(
      `[env.worker] ${gaps.length} module(s) still routed to MongoDB and unreachable from a ` +
        `Worker: ${detail}. Requests touching them will throw.`,
    );
  }

  return {
    ...v,
    isProduction: v.NODE_ENV === 'production',
    isDevelopment: v.NODE_ENV === 'development',
    isTest: v.NODE_ENV === 'test',
    maxUploadBytes: v.MAX_UPLOAD_SIZE_MB * MB,
    googleDriveUploadChunkBytes: v.GOOGLE_DRIVE_UPLOAD_CHUNK_MB * MB,
    storageProvider: 'google_drive',
  };
}

export function getWorkerEnv(source: Record<string, string | undefined>): WorkerEnv {
  cached ??= loadWorkerEnv(source);
  return cached;
}

export function resetWorkerEnvCache(): void {
  cached = null;
}
