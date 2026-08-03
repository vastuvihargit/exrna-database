/**
 * Global test setup.
 *
 * Provides a valid baseline environment so `src/server/config/env.ts` can be imported
 * by unit tests without a real .env file. Individual tests may override values before
 * importing the module under test (env parsing is lazy + resettable).
 */
import os from 'node:os';
import path from 'node:path';

const testRoot = path.join(os.tmpdir(), 'biotech-drive-tests');

// NODE_ENV is typed read-only by @types/node; tests legitimately need to set it.
const env = process.env as Record<string, string | undefined>;

env.NODE_ENV ??= 'test';
env.APP_URL ??= 'http://localhost:3000';
env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/biotech_drive_test';
env.MONGODB_DATABASE ??= 'biotech_drive_test';
env.AUTH_SECRET ??= 'test-auth-secret-value-that-is-long-enough-32';
env.SESSION_SECRET ??= 'test-session-secret-value-that-is-long-enough';
env.COMPANY_EMAIL_DOMAINS ??= 'company.com';
env.ALLOW_AUTO_PROVISIONING ??= 'false';
env.LOCAL_STORAGE_ROOT ??= path.join(testRoot, 'storage');
env.TEMP_UPLOAD_ROOT ??= path.join(testRoot, 'temp');
env.QUARANTINE_ROOT ??= path.join(testRoot, 'quarantine');
env.PREVIEW_ROOT ??= path.join(testRoot, 'previews');
env.EXPORT_ROOT ??= path.join(testRoot, 'exports');
env.BACKUP_ROOT ??= path.join(testRoot, 'backups');
env.LOG_LEVEL ??= 'silent';
// Uploads refuse to run the volume below this floor. Tests write kilobytes, so the floor
// is disabled here — otherwise the upload suite would pass or fail according to how full
// the developer's disk happens to be, which tests nothing about the application.
env.MIN_FREE_DISK_GB ??= '0';
