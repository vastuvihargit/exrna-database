/**
 * A deliberately incapable Google Drive client.
 *
 * The brief's hardest requirement for migration is a *negative* one: "never delete or
 * modify the original Google Drive files automatically". This module is how that is
 * guaranteed rather than promised.
 *
 *  • The only OAuth scope requested is `drive.readonly`. Google itself will refuse a
 *    write with this token.
 *  • Every request goes through `driveGet`, which hard-codes `method: 'GET'`. There is no
 *    function in this file that can issue a POST, PATCH, PUT or DELETE to Drive, so a
 *    future change would have to add one — a visible, reviewable act, not an accident.
 *
 * The client is also framework-free and takes its credentials as arguments, which is what
 * lets the migration tests exercise the import pipeline against a stub.
 */
import { ValidationError } from '@/server/errors/app-error';
import { getEnv } from '@/server/config/env';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

/** Read-only, and `.readonly` is the entire security argument above. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly openid email';

export const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * Google-native documents have no bytes to download; they are exported.
 * Anything Google-native not in this map is skipped and reported, never guessed at.
 */
export const GOOGLE_EXPORT_FORMATS: Record<string, { mimeType: string; extension: string }> = {
  'application/vnd.google-apps.document': {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx',
  },
  'application/vnd.google-apps.spreadsheet': {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: 'xlsx',
  },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extension: 'pptx',
  },
  'application/vnd.google-apps.drawing': { mimeType: 'image/png', extension: 'png' },
  'application/vnd.google-apps.script': { mimeType: 'application/json', extension: 'json' },
};

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  size?: string;
  md5Checksum?: string;
  createdTime?: string;
  modifiedTime?: string;
  trashed?: boolean;
}

export interface DriveListPage {
  files: DriveFile[];
  nextPageToken?: string;
}

/**
 * What the migration service needs from Drive.
 *
 * An interface rather than a concrete class so the import pipeline — the part with the
 * checksums, the deduplication and the folder mapping — is testable without a Google
 * account, which is the part actually worth testing.
 */
export interface DriveReader {
  listChildren(folderId: string, pageToken?: string): Promise<DriveListPage>;
  getFile(fileId: string): Promise<DriveFile>;
  /** Byte stream for a binary file. */
  download(fileId: string): Promise<NodeJS.ReadableStream>;
  /** Byte stream for a Google-native document, converted to `mimeType`. */
  export(fileId: string, mimeType: string): Promise<NodeJS.ReadableStream>;
}

export function isDriveConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_DRIVE_REDIRECT_URI);
}

/**
 * The consent URL for connecting a Drive account to a migration job.
 *
 * `access_type=offline` with `prompt=consent` is what makes Google return a refresh
 * token — a migration of forty thousand files runs for hours and must survive the
 * one-hour access-token lifetime, and pausing and resuming it tomorrow is an explicit
 * requirement.
 */
export function buildConsentUrl(input: { state: string; loginHint?: string }): string {
  const env = getEnv();
  if (!isDriveConfigured()) {
    throw new ValidationError('Google Drive migration is not configured on this deployment');
  }

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: env.GOOGLE_DRIVE_REDIRECT_URI!,
    response_type: 'code',
    scope: DRIVE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state: input.state,
  });
  if (input.loginHint) params.set('login_hint', input.loginHint);

  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export interface DriveGrant {
  refreshToken: string;
  accessToken: string;
  scope: string;
  accountEmail: string | null;
}

export async function exchangeCode(code: string): Promise<DriveGrant> {
  const env = getEnv();
  if (!isDriveConfigured()) throw new ValidationError('Google Drive migration is not configured');

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: env.GOOGLE_DRIVE_REDIRECT_URI!,
      grant_type: 'authorization_code',
    }),
    cache: 'no-store',
  });

  if (!response.ok) throw new ValidationError('Google rejected the Drive authorization');

  const tokens = (await response.json()) as {
    refresh_token?: string;
    access_token?: string;
    scope?: string;
  };
  if (!tokens.refresh_token || !tokens.access_token) {
    throw new ValidationError(
      'Google did not return a refresh token. Remove this app from your Google account permissions and connect again.',
    );
  }

  // A grant that does not include the read scope is useless, and accepting it would
  // produce a job that fails halfway through a scan instead of at connection time.
  if (!tokens.scope?.includes('drive.readonly')) {
    throw new ValidationError('The Drive read-only permission was not granted');
  }

  let accountEmail: string | null = null;
  try {
    const profile = await fetch(USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      cache: 'no-store',
    });
    if (profile.ok) {
      const body = (await profile.json()) as { email?: string };
      accountEmail = typeof body.email === 'string' ? body.email.toLowerCase() : null;
    }
  } catch {
    // Cosmetic — the migration works without knowing which account authorized it.
  }

  return {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    scope: tokens.scope,
    accountEmail,
  };
}

export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const env = getEnv();
  if (!isDriveConfigured()) throw new ValidationError('Google Drive migration is not configured');

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      grant_type: 'refresh_token',
    }),
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new ValidationError('The Google Drive connection has expired. Reconnect the account.');
  }
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new ValidationError('Google did not return an access token');
  return body.access_token;
}

/**
 * The live reader.
 *
 * Holds an access token and refreshes it lazily — a scan of a large Drive outlives the
 * hour Google grants, and failing at minute 61 of a two-hour job is not an acceptable
 * design.
 */
export class GoogleDriveReader implements DriveReader {
  private accessToken: string | null = null;

  constructor(private readonly refreshToken: string) {}

  private async token(force = false): Promise<string> {
    if (!this.accessToken || force) {
      this.accessToken = await refreshAccessToken(this.refreshToken);
    }
    return this.accessToken;
  }

  /** The only request function in this module, and it is a GET. */
  private async driveGet(path: string, params: Record<string, string>): Promise<Response> {
    const url = `${DRIVE_API}${path}?${new URLSearchParams(params).toString()}`;

    let response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${await this.token()}` },
      cache: 'no-store',
    });

    // One retry on 401: the token expired mid-run rather than the grant being revoked.
    if (response.status === 401) {
      response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${await this.token(true)}` },
        cache: 'no-store',
      });
    }

    if (!response.ok) {
      throw new ValidationError(`Google Drive returned ${response.status} for ${path}`);
    }
    return response;
  }

  async listChildren(folderId: string, pageToken?: string): Promise<DriveListPage> {
    const params: Record<string, string> = {
      // `folderId` comes from Drive's own responses or from an id the administrator
      // pasted; it is quoted and escaped so it cannot alter the query's shape.
      q: `'${escapeDriveId(folderId)}' in parents and trashed = false`,
      fields:
        'nextPageToken, files(id, name, mimeType, parents, size, md5Checksum, createdTime, modifiedTime, trashed)',
      pageSize: '200',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      orderBy: 'folder,name',
    };
    if (pageToken) params.pageToken = pageToken;

    const response = await this.driveGet('/files', params);
    return (await response.json()) as DriveListPage;
  }

  async getFile(fileId: string): Promise<DriveFile> {
    const response = await this.driveGet(`/files/${encodeURIComponent(fileId)}`, {
      fields: 'id, name, mimeType, parents, size, md5Checksum, createdTime, modifiedTime, trashed',
      supportsAllDrives: 'true',
    });
    return (await response.json()) as DriveFile;
  }

  async download(fileId: string): Promise<NodeJS.ReadableStream> {
    const response = await this.driveGet(`/files/${encodeURIComponent(fileId)}`, {
      alt: 'media',
      supportsAllDrives: 'true',
    });
    return toNodeStream(response);
  }

  async export(fileId: string, mimeType: string): Promise<NodeJS.ReadableStream> {
    const response = await this.driveGet(`/files/${encodeURIComponent(fileId)}/export`, {
      mimeType,
    });
    return toNodeStream(response);
  }
}

/**
 * A Drive id in a `q` expression is inside single quotes. Drive ids are base64url-ish and
 * never contain a quote, but the escape is applied anyway rather than assumed — the same
 * reason the rest of this codebase never interpolates an unescaped value into a query.
 */
function escapeDriveId(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function toNodeStream(response: Response): Promise<NodeJS.ReadableStream> {
  if (!response.body) throw new ValidationError('Google Drive returned an empty response body');
  const { Readable } = await import('stream');
  return Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
}
