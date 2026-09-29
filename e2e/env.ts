/**
 * The E2E environment, in one place: what the dev server runs with and what global setup seeds.
 *
 * Everything is isolated from the developer's own data:
 *   • MongoDB database `biotech_drive_e2e` on the local mongod (dropped and re-seeded per run);
 *   • D1 persisted under the OS temp directory, not `.wrangler/state`;
 *   • file storage under the same temp directory.
 *
 * `E2E_BACKEND=d1` (the default) routes every module to D1 through wrangler's local platform
 * proxy — the same workerd SQLite a Worker uses — with bytes on local disk, because a Worker's
 * only storage is Google Drive and no Drive credentials exist for a test run.
 * `E2E_BACKEND=mongo` runs the same suite against the MongoDB deployment as it is today.
 */
import os from 'node:os';
import path from 'node:path';

export const E2E_PORT = Number(process.env.E2E_PORT ?? 3100);
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
export const E2E_BACKEND = (process.env.E2E_BACKEND ?? 'd1') as 'd1' | 'mongo';
export const E2E_STATE_DIR = path.join(os.tmpdir(), 'biotech-drive-e2e');
export const E2E_D1_DIR = path.join(E2E_STATE_DIR, 'd1');
export const E2E_DATABASE = 'biotech_drive_e2e';
export const E2E_MONGODB_URI =
  process.env.E2E_MONGODB_URI ?? `mongodb://127.0.0.1:27017/${E2E_DATABASE}?replicaSet=rs0`;

/** Shared by every seeded account. Satisfies the password policy. */
export const E2E_PASSWORD = 'Research-Drive-E2e!2026';

export const USERS = {
  admin: { email: 'admin@company.com', name: 'Ada Admin' },
  /** Department head of MOLBIO: can approve. */
  head: { email: 'maya.okonkwo@company.com', name: 'Maya Okonkwo' },
  /** Research scientist in BIOINF: the scientist in the flow. */
  scientist: { email: 'tomas.lindqvist@company.com', name: 'Tomas Lindqvist' },
  /** Lab technician in ANCHEM. */
  technician: { email: 'priya.raman@company.com', name: 'Priya Raman' },
} as const;

const DATA_SOURCE_FLAGS = [
  'ORGANIZATIONS', 'USERS', 'DEPARTMENTS', 'ROLES', 'PROJECTS', 'EXPERIMENTS', 'FOLDERS', 'FILES',
  'FILE_VERSIONS', 'SEARCH', 'REVIEWS', 'AUDIT_LOGS', 'INVENTORY', 'NOTIFICATIONS', 'SESSIONS',
  'LOGIN_HISTORY', 'STORAGE_USAGE', 'ACTIVITIES', 'COMMENTS', 'DRIVE_SYNC', 'UPLOAD_SESSIONS',
  'APP_SETTINGS',
];

/** Environment for the scripts (seed, migrate) and, with the D1 routing added, the server. */
export function baseEnv(): Record<string, string> {
  const storage = path.join(E2E_STATE_DIR, 'storage');
  return {
    APP_URL: E2E_BASE_URL,
    MONGODB_URI: E2E_MONGODB_URI,
    MONGODB_DATABASE: E2E_DATABASE,
    AUTH_SECRET: 'e2e-auth-secret-0123456789-abcdefghijklmnop',
    SESSION_SECRET: 'e2e-session-secret-0123456789-abcdefghijklm',
    COMPANY_EMAIL_DOMAINS: 'company.com',
    ALLOW_AUTO_PROVISIONING: 'false',
    ENABLE_DEV_SWITCHER: 'false',
    LOG_LEVEL: 'warn',
    MIN_FREE_DISK_GB: '0',
    MALWARE_SCAN_MODE: 'disabled',
    MAINTENANCE_MODE: 'off',
    GOOGLE_DRIVE_STORAGE_ENABLED: 'false',
    DEFAULT_STORAGE_PROVIDER: 'local',
    UPLOAD_STAGING: 'local',
    CF_ACCESS_TEAM_DOMAIN: '',
    CF_ACCESS_AUD: '',
    LOCAL_STORAGE_ROOT: path.join(storage, 'objects'),
    TEMP_UPLOAD_ROOT: path.join(storage, 'temp'),
    QUARANTINE_ROOT: path.join(storage, 'quarantine'),
    PREVIEW_ROOT: path.join(storage, 'previews'),
    EXPORT_ROOT: path.join(storage, 'exports'),
    BACKUP_ROOT: path.join(storage, 'backups'),
  };
}

export function serverEnv(): Record<string, string> {
  const env = baseEnv();
  if (E2E_BACKEND === 'd1') {
    for (const flag of DATA_SOURCE_FLAGS) env[`DATA_SOURCE_${flag}`] = 'd1';
    // `wrangler --persist-to X` keeps its state under `X/v3`; the platform proxy is handed the
    // `v3` directory itself. Pointing it at `X` opens a second, empty database.
    env.D1_LOCAL_PROXY_PERSIST = path.join(E2E_D1_DIR, 'v3');
  }
  return env;
}
