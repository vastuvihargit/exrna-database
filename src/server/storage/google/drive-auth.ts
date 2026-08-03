/**
 * Service-account access tokens for the Drive API.
 *
 * Isolated behind `AccessTokenSource` for one reason: it is the only part of the Drive
 * provider that must talk to Google to do its job, so making it an interface is what lets
 * every provider test run with **zero network access** against a stub that returns a
 * constant string. The tests then exercise the code that is actually worth testing — the
 * resumable-upload state machine, the retry classifier, the folder adoption — instead of
 * being blocked on a service account nobody has in CI.
 *
 * `google-auth-library` is used rather than hand-rolled RS256 because it already handles
 * the parts that are easy to get subtly wrong and hard to notice: JWT assertion signing,
 * token caching, pre-emptive refresh before expiry, and clock-skew tolerance. It is the
 * only dependency this migration adds; the Drive REST calls themselves stay hand-written
 * `fetch`, matching the existing inbound-importer client.
 */
import { JWT } from 'google-auth-library';
import { StorageError } from '@/server/errors/app-error';
import type { DriveStorageConfig } from './drive-config';

/**
 * Read/write on Drive, bounded in practice by Shared Drive membership: this credential can
 * see exactly the one drive it has been added to, and nothing else in the Workspace domain.
 *
 * There is no narrower scope that supports creating content. `drive.file` only grants
 * access to files the *app itself* created, which would make every already-existing file in
 * the Shared Drive — including everything a migration puts there under a previous key —
 * invisible to the application.
 */
export const DRIVE_STORAGE_SCOPE = 'https://www.googleapis.com/auth/drive';

export interface AccessTokenSource {
  /** A currently-valid bearer token. Implementations cache; callers must not. */
  getAccessToken(): Promise<string>;
  /**
   * Discards any cached token so the next call mints a fresh one. Used on a 401, which
   * means the token died earlier than its stated expiry (a revoked key, a clock jump).
   */
  invalidate(): void;
}

export class ServiceAccountTokenSource implements AccessTokenSource {
  private client: JWT | null = null;

  constructor(private readonly config: DriveStorageConfig) {}

  /**
   * Constructed lazily. Building the client is pure — it makes no network call — but
   * deferring it keeps "the process started" independent of "the key parses", so a bad key
   * surfaces on the admin connection panel rather than as a boot crash of the whole app.
   */
  private jwt(): JWT {
    this.client ??= new JWT({
      email: this.config.serviceAccountEmail,
      key: this.config.privateKey,
      scopes: [DRIVE_STORAGE_SCOPE],
    });
    return this.client;
  }

  async getAccessToken(): Promise<string> {
    let token: string | null | undefined;
    try {
      ({ token } = await this.jwt().getAccessToken());
    } catch (error) {
      // The cause is attached for the server log; the message is generic because this one
      // can contain fragments of the credential in some library failure modes.
      throw new StorageError(
        'STORAGE_ERROR',
        'Could not authenticate with Google Drive. The service-account key may be invalid, revoked, or the ' +
          'system clock may be wrong.',
        error,
      );
    }

    if (!token) {
      throw new StorageError('STORAGE_ERROR', 'Google returned no access token for the service account');
    }
    return token;
  }

  invalidate(): void {
    // Dropping the client drops its cached token with it. Cheap: the replacement is
    // constructed without I/O and mints a token on first use.
    this.client = null;
  }
}
