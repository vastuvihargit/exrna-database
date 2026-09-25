/**
 * Environment validation — parsed exactly once, at boot, and fail-fast.
 *
 * An invalid configuration must crash the process rather than let the application
 * run in a half-configured state (a storage root pointing at the wrong disk or a
 * missing session secret are silent data-loss / security bugs otherwise).
 *
 * See docs/phase-0/09-deployment-and-backup.md for the per-environment matrix.
 */
import path from 'path';
import { z } from 'zod';
import { assertDataSourceMatrix } from '@/server/repositories/data-source';

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

/** A comma-separated list of lower-cased, trimmed, non-empty domains. */
const domainList = z
  .string()
  .min(1, 'COMPANY_EMAIL_DOMAINS must list at least one domain')
  .transform((v) =>
    v
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  )
  .refine((list) => list.length > 0, 'COMPANY_EMAIL_DOMAINS must list at least one domain')
  .refine(
    (list) => list.every((d) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)),
    'COMPANY_EMAIL_DOMAINS contains an invalid domain',
  );

const envSchema = z
  .object({
    // Application
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    APP_URL: z.string().url().default('http://localhost:3000'),
    APP_NAME: z.string().default('Biotech Research Drive'),
    PORT: int(3000, 1, 65535),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    // Database
    MONGODB_URI: z
      .string()
      .min(1)
      .refine(
        (v) => v.startsWith('mongodb://') || v.startsWith('mongodb+srv://'),
        'MONGODB_URI must start with mongodb:// or mongodb+srv://',
      ),
    MONGODB_DATABASE: z.string().min(1).default('biotech_drive'),

    // Secrets
    AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),

    // Company-email-only access
    COMPANY_EMAIL_DOMAINS: domainList,
    ALLOW_AUTO_PROVISIONING: bool(false),

    // Private server storage roots
    LOCAL_STORAGE_ROOT: z.string().min(1),
    TEMP_UPLOAD_ROOT: z.string().min(1),
    QUARANTINE_ROOT: z.string().min(1),
    PREVIEW_ROOT: z.string().min(1),
    EXPORT_ROOT: z.string().min(1),
    BACKUP_ROOT: z.string().default('/data/backups'),

    // Limits & quotas
    MAX_UPLOAD_SIZE_MB: int(2048, 1, 1024 * 1024),
    DEFAULT_USER_STORAGE_QUOTA_GB: int(20, 1),
    DEFAULT_DEPARTMENT_STORAGE_QUOTA_GB: int(500, 1),
    MIN_FREE_DISK_GB: int(10, 0),
    UPLOAD_CHUNK_SIZE_MB: int(8, 1, 512),

    // Retention
    TRASH_RETENTION_DAYS: int(30, 1),
    INCOMPLETE_UPLOAD_RETENTION_HOURS: int(24, 1),
    EXPORT_RETENTION_HOURS: int(24, 1),

    // Malware scanning (Phase 11). Disabled by default: a deployment with no antivirus
    // is a stated risk reported on the admin system page, never a silent one.
    MALWARE_SCAN_ENABLED: bool(false),
    /**
     * Which scanner, stated explicitly. Wins over `MALWARE_SCAN_ENABLED`, which remains as the
     * older spelling of `clamav`. `http` is the vendor-neutral boundary a Worker can use — clamd
     * needs a raw TCP socket, which workerd does not have. See `security/malware-scanner.ts` for
     * the wire contract.
     */
    MALWARE_SCAN_MODE: z.enum(['disabled', 'clamav', 'http']).optional(),
    MALWARE_SCAN_ENDPOINT: z.string().url().optional(),
    MALWARE_SCAN_SECRET: z.string().optional(),
    MALWARE_SCAN_TIMEOUT_MS: int(120_000, 1000, 900_000),
    CLAMAV_HOST: z.string().default('clamav'),
    CLAMAV_PORT: int(3310, 1, 65535),
    CLAMAV_TIMEOUT_MS: int(60_000, 1000, 600_000),
    /**
     * What an *inconclusive* scan means. Overridden to `true` in production below: a
     * scanner that is down means "unknown", and treating unknown as clean is how an
     * antivirus deployment quietly stops protecting anything.
     */
    MALWARE_SCAN_FAIL_CLOSED: bool(false),

    // Sessions
    SESSION_IDLE_TIMEOUT_MINUTES: int(480, 5),
    SESSION_ABSOLUTE_TIMEOUT_MINUTES: int(720, 5),

    /**
     * Developer tooling (the 🛠 DEV switcher).
     *
     * On by default outside production so it is there when you need it, and off with
     * `false` for a staging box that should behave like production. It can never turn
     * the feature *on* in production — see the superRefine below, which refuses to boot
     * rather than silently ignoring the request.
     */
    ENABLE_DEV_SWITCHER: bool(true),

    // Backup
    BACKUP_RETENTION_DAYS: int(30, 1),
    BACKUP_ENCRYPTION_PASSWORD: z.string().optional(),
    BACKUP_OFFSITE_TARGET: z.string().optional(),

    /**
     * Where disk, backup and scanner alerts are POSTed, in addition to the structured
     * log line that always happens. Optional: an unset webhook degrades to log-only
     * alerting rather than to no alerting.
     */
    ALERT_WEBHOOK_URL: z
      .string()
      .url('ALERT_WEBHOOK_URL must be a URL')
      .optional()
      .or(z.literal('').transform(() => undefined)),

    /**
     * Cloudflare Access in front of the application. When both are set, Access is the sign-in
     * method: every request must carry a valid Access assertion for the same person as its
     * session, and password / Google sign-in are switched off. Unset — local development and
     * the existing Node deployment — nothing about sign-in changes. See `auth/access-session.ts`.
     */
    CF_ACCESS_TEAM_DOMAIN: z.string().optional(),
    CF_ACCESS_AUD: z.string().optional(),

    // OAuth (required only once Phase 2 enables the provider)
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_REDIRECT_URI: z.string().optional(),
    /**
     * Separate from the sign-in callback on purpose: the Drive migration grant carries a
     * far broader scope, so it gets its own redirect and cannot be obtained by replaying
     * a login flow.
     */
    GOOGLE_DRIVE_REDIRECT_URI: z.string().optional(),
    /**
     * ── Google Shared Drive as a storage backend ──────────────────────────────
     *
     * Namespaced `GOOGLE_DRIVE_STORAGE_*` / `GOOGLE_SHARED_DRIVE_*` to keep it clear of the
     * two Google features that already exist here and mean something else:
     * `GOOGLE_CLIENT_ID`/`GOOGLE_REDIRECT_URI` are employee sign-in, and
     * `GOOGLE_DRIVE_REDIRECT_URI` belongs to the *inbound* Drive importer, which is
     * read-only and runs in the opposite direction. See §3 of
     * docs/storage-migration/00-phase-0-analysis.md.
     *
     * Every variable below is optional, and with the flag off none of them is read. A
     * deployment that never sets any of them behaves exactly as it does today.
     */
    GOOGLE_DRIVE_STORAGE_ENABLED: bool(false),
    /** Where *new* content is written. Existing records always read from their own field. */
    DEFAULT_STORAGE_PROVIDER: z.enum(['local', 'google_drive']).default('local'),

    /**
     * Where bytes are held while they are still untrusted — and, by consequence, whether a
     * newly uploaded file has a local copy at all.
     *
     * This is **not** a duplicate of `DEFAULT_STORAGE_PROVIDER`, and conflating the two was
     * tempting enough to be worth stating why it is wrong:
     *
     *   • `local` (the default) — bytes are streamed to local quarantine, scanned, moved into
     *     `originals`, recorded, and *then* handed to Drive if `DEFAULT_STORAGE_PROVIDER` says
     *     so. The local copy is retained for `LOCAL_COPY_RETENTION_DAYS`, and **that retained
     *     copy is the entire rollback plan for the byte migration.** A Drive outage during this
     *     window costs latency, not availability.
     *
     *   • `google_drive` — bytes are streamed straight into a Drive resumable upload in a
     *     staging folder and promoted by re-parenting. Nothing is ever written to a disk, so
     *     there is **no local copy and no local-copy fallback** for anything uploaded this way.
     *
     * A Cloudflare Worker has no persistent filesystem, so `google_drive` is the only value it
     * can run with — `loadWorkerEnv` defaults to it and refuses `local`. On Node, `local`
     * remains the default precisely because giving up the rollback copy should be a decision
     * somebody made rather than one a deployment inherited.
     */
    UPLOAD_STAGING: z.enum(['local', 'google_drive']).default('local'),

    GOOGLE_WORKSPACE_DOMAIN: z.string().optional(),
    GOOGLE_SHARED_DRIVE_ID: z.string().optional(),
    /** A folder *inside* the Shared Drive. Blank means the drive's own root. */
    GOOGLE_DRIVE_ROOT_FOLDER_ID: z.string().optional(),

    GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL: z.string().optional(),
    /** Development only: the PEM inline, with `\n` escapes. */
    GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY: z.string().optional(),
    /** Production: a path to a mounted Docker/K8s secret. Takes precedence over the inline value. */
    GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY_FILE: z.string().optional(),

    /**
     * Above this size, a newly uploaded file is queued for Drive rather than transferred
     * during the request.
     *
     * It is a latency control, not a correctness one: below the threshold the extra second
     * or two is invisible and the file is in Drive immediately; above it, holding the
     * request open for a multi-gigabyte server→Drive transfer would exceed the platform's
     * 300-second ceiling. Either way the file is complete and readable the moment finalize
     * returns — only *where* its bytes live differs, and Phase 4 serves both.
     */
    UPLOAD_DRIVE_SYNC_THRESHOLD_MB: int(100, 0, 1024 * 1024),

    /**
     * Whether employees may open a Google-native document in the Google editor.
     *
     * Off by default, and the default is the point. Every Drive operation in this
     * application runs as the service account; an employee's own Google identity is not
     * necessarily a member of the Shared Drive at all (§13 of the brief: they "should not
     * require direct access to every underlying Shared Drive file unless the product
     * intentionally supports it"). Showing an "Open in Google Docs" button on a deployment
     * where that is not true sends people to a Google permission-denied page and makes the
     * application look broken over something it cannot fix.
     *
     * Turn this on only when the Shared Drive is genuinely shared with the staff who use
     * this application. Note what it means when it is on: what they may do *inside* the
     * Google editor is governed by Drive's sharing, not by this application's permissions.
     */
    GOOGLE_DRIVE_NATIVE_EDITOR_ENABLED: bool(false),

    /**
     * How often synchronization from Drive's change feed is expected to run.
     *
     * This does **not** schedule anything — `npm run drive:sync` is driven by cron. It is
     * what the admin System page compares against to decide whether synchronization has
     * stalled. Setting it without actually scheduling the job produces a warning, which is
     * the correct outcome: a deployment that believes it is synchronizing and is not is
     * exactly the state worth complaining about.
     */
    DRIVE_SYNC_INTERVAL_MINUTES: int(15, 1, 1440),

    GOOGLE_DRIVE_UPLOAD_CHUNK_MB: int(16, 1, 512),
    GOOGLE_DRIVE_MAX_CONCURRENT_TRANSFERS: int(4, 1, 32),
    GOOGLE_DRIVE_REQUEST_TIMEOUT_MS: int(120_000, 1000, 900_000),

    /**
     * Local copies are retained after a version is migrated, because that is the entire
     * rollback mechanism: reverting to local storage is a field flip with no data movement
     * (§8 of the Phase 0 analysis) and only works while the bytes are still there.
     */
    LOCAL_COPY_RETENTION_DAYS: int(30, 0),
    DELETE_LOCAL_AFTER_MIGRATION: bool(false),

    MICROSOFT_CLIENT_ID: z.string().optional(),
    MICROSOFT_CLIENT_SECRET: z.string().optional(),
    MICROSOFT_TENANT_ID: z.string().optional(),
    MICROSOFT_REDIRECT_URI: z.string().optional(),

    // Mail
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: int(587, 1, 65535),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_FROM: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.SESSION_ABSOLUTE_TIMEOUT_MINUTES < v.SESSION_IDLE_TIMEOUT_MINUTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SESSION_ABSOLUTE_TIMEOUT_MINUTES'],
        message: 'SESSION_ABSOLUTE_TIMEOUT_MINUTES must be >= SESSION_IDLE_TIMEOUT_MINUTES',
      });
    }

    /**
     * Google Shared Drive storage — refuse to boot rather than start half-configured.
     *
     * Each of these would otherwise surface as a runtime failure on somebody's upload,
     * hours later, with a stack trace instead of a cause. The storage backend is the one
     * subsystem where "start anyway and fail on first use" risks losing bytes.
     */
    const hasDriveKey = Boolean(
      v.GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY_FILE || v.GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY,
    );

    if (v.DEFAULT_STORAGE_PROVIDER === 'google_drive' && !v.GOOGLE_DRIVE_STORAGE_ENABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DEFAULT_STORAGE_PROVIDER'],
        message:
          'cannot be "google_drive" while GOOGLE_DRIVE_STORAGE_ENABLED is false — every new upload would fail',
      });
    }

    /**
     * The HTTP scanner fails at configuration time, not on somebody's upload. A shared secret
     * shorter than 16 characters is refused because it authenticates this application to the
     * scanning service, and a guessable one lets anybody spend its quota — or, worse, answer in
     * its place if the endpoint is ever misrouted.
     */
    // Half of an Access configuration is the dangerous half: a team domain with no audience
    // would verify any Access application's token on the same team.
    if (Boolean(v.CF_ACCESS_TEAM_DOMAIN?.trim()) !== Boolean(v.CF_ACCESS_AUD?.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [v.CF_ACCESS_TEAM_DOMAIN ? 'CF_ACCESS_AUD' : 'CF_ACCESS_TEAM_DOMAIN'],
        message: 'CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must be set together, or neither',
      });
    }

    if (v.MALWARE_SCAN_MODE === 'http') {
      if (!v.MALWARE_SCAN_ENDPOINT) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MALWARE_SCAN_ENDPOINT'],
          message: 'is required when MALWARE_SCAN_MODE is "http"',
        });
      } else if (v.NODE_ENV === 'production' && !v.MALWARE_SCAN_ENDPOINT.startsWith('https://')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MALWARE_SCAN_ENDPOINT'],
          message: 'must use https:// in production — file content is sent to it',
        });
      }
      if (!v.MALWARE_SCAN_SECRET || v.MALWARE_SCAN_SECRET.length < 16) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MALWARE_SCAN_SECRET'],
          message: 'must be at least 16 characters when MALWARE_SCAN_MODE is "http"',
        });
      }
    }

    if (v.UPLOAD_STAGING === 'google_drive' && !v.GOOGLE_DRIVE_STORAGE_ENABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['UPLOAD_STAGING'],
        message:
          'cannot be "google_drive" while GOOGLE_DRIVE_STORAGE_ENABLED is false — every upload would ' +
          'have nowhere to be staged',
      });
    }

    /**
     * Staging in Drive while new content is recorded as local would produce versions whose
     * `storageProvider` says `local` and whose bytes are in the Shared Drive. Every read would
     * then look for a file on a disk that was never written.
     */
    if (v.UPLOAD_STAGING === 'google_drive' && v.DEFAULT_STORAGE_PROVIDER !== 'google_drive') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['UPLOAD_STAGING'],
        message:
          'is "google_drive" but DEFAULT_STORAGE_PROVIDER is "local" — content staged in Drive is ' +
          'already in Drive and cannot be recorded as local. Set both, or neither.',
      });
    }

    if (v.GOOGLE_DRIVE_STORAGE_ENABLED) {
      if (!v.GOOGLE_SHARED_DRIVE_ID) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['GOOGLE_SHARED_DRIVE_ID'],
          message:
            'is required when GOOGLE_DRIVE_STORAGE_ENABLED is true. Company files must live in a Shared Drive, ' +
            'never in an individual\'s My Drive: a Shared Drive owns its own content, so files survive the ' +
            'employee leaving, and a service account has no personal storage quota to write against.',
        });
      }
      if (!v.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL'],
          message: 'is required when GOOGLE_DRIVE_STORAGE_ENABLED is true',
        });
      }
      if (!hasDriveKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY_FILE'],
          message:
            'a service-account key is required when GOOGLE_DRIVE_STORAGE_ENABLED is true. Set ' +
            'GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY_FILE (a mounted secret; preferred) or ' +
            'GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY (development only)',
        });
      }
    }

    if (v.DELETE_LOCAL_AFTER_MIGRATION && v.LOCAL_COPY_RETENTION_DAYS === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['LOCAL_COPY_RETENTION_DAYS'],
        message:
          'must be greater than 0 when DELETE_LOCAL_AFTER_MIGRATION is true — a zero-day retention ' +
          'deletes the only rollback copy the moment a migration is verified',
      });
    }

    if (v.NODE_ENV === 'production') {
      if (v.APP_URL.startsWith('http://')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['APP_URL'],
          message: 'APP_URL must use https:// in production',
        });
      }
      if (v.AUTH_SECRET === v.SESSION_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SESSION_SECRET'],
          message: 'AUTH_SECRET and SESSION_SECRET must differ in production',
        });
      }
    }
  });

/**
 * Refuses to boot when a production configuration explicitly asks for the dev switcher.
 *
 * Silently disabling it would leave whoever set the variable believing it worked, and
 * the next person reading the config believing it is enabled. Stopping is the honest
 * response to "you have asked for something that must never happen here".
 *
 * Reads the raw source rather than the parsed value because the schema defaults the flag
 * to true — "is it true?" cannot tell "the operator set it" from "nobody mentioned it",
 * and only an explicit request is an error. An unset variable in production is the
 * normal case and simply stays off.
 */
function assertDevSwitcherNotRequestedInProduction(
  parsed: RawEnv,
  source: NodeJS.ProcessEnv,
): void {
  if (parsed.NODE_ENV !== 'production') return;

  const raw = source.ENABLE_DEV_SWITCHER;
  if (raw === undefined || raw === '') return;
  if (!parsed.ENABLE_DEV_SWITCHER) return;

  throw new Error(
    'Invalid environment configuration:\n' +
      '  • ENABLE_DEV_SWITCHER: must not be enabled in production.\n\n' +
      'The developer user switcher can issue a session for another employee without their ' +
      'password. It cannot run against production data under any configuration. Remove the ' +
      'variable from the production environment.',
  );
}

export type RawEnv = z.infer<typeof envSchema>;

export type MalwareScanMode = 'disabled' | 'clamav' | 'http';

export function resolveMalwareScanMode(v: {
  MALWARE_SCAN_MODE?: MalwareScanMode | undefined;
  MALWARE_SCAN_ENABLED: boolean;
}): MalwareScanMode {
  return v.MALWARE_SCAN_MODE ?? (v.MALWARE_SCAN_ENABLED ? 'clamav' : 'disabled');
}

/**
 * Storage roots resolved to absolute paths.
 *
 * Relative values (handy on a developer machine: `./.data/storage`) are resolved
 * against the project root; absolute values (`/data/storage` in containers) pass through.
 */
export interface StorageRoots {
  storage: string;
  temp: string;
  quarantine: string;
  previews: string;
  exports: string;
  backups: string;
}

export interface AppEnv extends RawEnv {
  isProduction: boolean;
  isDevelopment: boolean;
  isTest: boolean;
  storageRoots: StorageRoots;
  maxUploadBytes: number;
  uploadChunkBytes: number;
  minFreeDiskBytes: number;
  defaultUserQuotaBytes: number;
  defaultDepartmentQuotaBytes: number;
  /** Resumable-upload chunk size for the Google Drive provider. */
  googleDriveUploadChunkBytes: number;
  /** Above this, a new upload is queued for Drive instead of transferred inline. */
  uploadDriveSyncThresholdBytes: number;
  /** The scanner actually in force: `MALWARE_SCAN_MODE`, else the legacy boolean. */
  malwareScanMode: MalwareScanMode;
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function resolveRoot(value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(process.cwd(), value);
}

/**
 * Storage roots must never live inside the web-served part of the application.
 * A misconfigured root that points at `public/` would make every uploaded research
 * file downloadable without authentication — the single worst failure this system has.
 */
function assertRootsArePrivate(roots: StorageRoots): void {
  const publicDir = path.resolve(process.cwd(), 'public');
  const nextDir = path.resolve(process.cwd(), '.next');
  const forbidden = [publicDir, nextDir];

  for (const [name, root] of Object.entries(roots)) {
    for (const bad of forbidden) {
      const rel = path.relative(bad, root);
      const isInside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
      if (isInside) {
        throw new Error(
          `Invalid storage configuration: "${name}" root (${root}) is inside the publicly served directory ${bad}. ` +
            'File storage must be private — see docs/phase-0/04-storage.md.',
        );
      }
    }
  }
}

let cached: AppEnv | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill in the missing values.`,
    );
  }

  assertDevSwitcherNotRequestedInProduction(parsed.data, source);

  const raw = parsed.data;
  // Scanning that is enabled in production fails closed unless the operator has
  // explicitly said otherwise. Applied here rather than in the schema so the reason sits
  // next to the decision.
  const v: RawEnv = {
    ...raw,
    MALWARE_SCAN_FAIL_CLOSED:
      raw.NODE_ENV === 'production' && resolveMalwareScanMode(raw) !== 'disabled'
        ? source.MALWARE_SCAN_FAIL_CLOSED === 'false' || source.MALWARE_SCAN_FAIL_CLOSED === '0'
          ? false
          : true
        : raw.MALWARE_SCAN_FAIL_CLOSED,
  };

  const storageRoots: StorageRoots = {
    storage: resolveRoot(v.LOCAL_STORAGE_ROOT),
    temp: resolveRoot(v.TEMP_UPLOAD_ROOT),
    quarantine: resolveRoot(v.QUARANTINE_ROOT),
    previews: resolveRoot(v.PREVIEW_ROOT),
    exports: resolveRoot(v.EXPORT_ROOT),
    backups: resolveRoot(v.BACKUP_ROOT),
  };

  assertRootsArePrivate(storageRoots);

  // Fails closed on a DATA_SOURCE_* split that would put a foreign key across two databases.
  // Here rather than at the first write, so the mistake surfaces at startup with the exact
  // pair named — see `dataSourceViolations()`.
  assertDataSourceMatrix();

  return {
    ...v,
    isProduction: v.NODE_ENV === 'production',
    isDevelopment: v.NODE_ENV === 'development',
    isTest: v.NODE_ENV === 'test',
    storageRoots,
    maxUploadBytes: v.MAX_UPLOAD_SIZE_MB * MB,
    uploadChunkBytes: v.UPLOAD_CHUNK_SIZE_MB * MB,
    minFreeDiskBytes: v.MIN_FREE_DISK_GB * GB,
    defaultUserQuotaBytes: v.DEFAULT_USER_STORAGE_QUOTA_GB * GB,
    defaultDepartmentQuotaBytes: v.DEFAULT_DEPARTMENT_STORAGE_QUOTA_GB * GB,
    googleDriveUploadChunkBytes: v.GOOGLE_DRIVE_UPLOAD_CHUNK_MB * MB,
    uploadDriveSyncThresholdBytes: v.UPLOAD_DRIVE_SYNC_THRESHOLD_MB * MB,
    malwareScanMode: resolveMalwareScanMode(v),
  };
}

/** Validated environment. Throws on first access if the configuration is invalid. */
export function getEnv(): AppEnv {
  cached ??= loadEnv();
  return cached;
}

/** Test-only: drop the memoized value so a test can re-parse a mutated process.env. */
export function resetEnvCache(): void {
  cached = null;
}
