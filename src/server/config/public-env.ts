/**
 * The only configuration values that may reach the browser.
 *
 * Everything not listed here stays server-side. This is an explicit allow-list so a
 * new secret can never leak into the client bundle by being added to the env schema.
 */
export interface PublicConfig {
  appName: string;
  appUrl: string;
  environment: string;
  maxUploadSizeMb: number;
  uploadChunkSizeMb: number;
  trashRetentionDays: number;
  companyEmailDomains: string[];
}

export function toPublicConfig(env: {
  APP_NAME: string;
  APP_URL: string;
  NODE_ENV: string;
  MAX_UPLOAD_SIZE_MB: number;
  UPLOAD_CHUNK_SIZE_MB: number;
  TRASH_RETENTION_DAYS: number;
  COMPANY_EMAIL_DOMAINS: string[];
}): PublicConfig {
  return {
    appName: env.APP_NAME,
    appUrl: env.APP_URL,
    environment: env.NODE_ENV,
    maxUploadSizeMb: env.MAX_UPLOAD_SIZE_MB,
    uploadChunkSizeMb: env.UPLOAD_CHUNK_SIZE_MB,
    trashRetentionDays: env.TRASH_RETENTION_DAYS,
    // Shown on the login screen ("use your @company.com address") — not a secret.
    companyEmailDomains: env.COMPANY_EMAIL_DOMAINS,
  };
}
