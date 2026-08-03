/**
 * The resumable-upload state machine and the retry classifier.
 *
 * These are the two pieces of the Drive client that cannot be exercised through the
 * in-memory fake, because the fake *is* the thing they talk to. They are also the riskiest
 * code in Phase 2: a mistake here does not throw, it writes a chunk at the wrong offset and
 * produces a file that uploads cleanly, verifies against nothing, and is corrupt.
 *
 * So the transport is stubbed instead, with a small model of Google's actual resumable
 * protocol — session creation, `308 Resume Incomplete`, `Range:` accounting, and the status
 * query that a retry must perform before it re-sends anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

import { GoogleDriveHttpClient } from '@/server/storage/google/drive-client';
import {
  backoffDelayMs,
  DriveApiError,
  driveErrorFromResponse,
  isRetryableDriveFailure,
  withDriveRetry,
} from '@/server/storage/google/drive-errors';
import type { AccessTokenSource } from '@/server/storage/google/drive-auth';
import type { DriveStorageConfig } from '@/server/storage/google/drive-config';

const SESSION_URI = 'https://upload.googleapis.com/resumable/session-1';

function config(overrides: Partial<DriveStorageConfig> = {}): DriveStorageConfig {
  return {
    sharedDriveId: 'drive-company',
    rootFolderId: 'root-folder',
    serviceAccountEmail: 'sa@example.iam.gserviceaccount.com',
    privateKey: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
    workspaceDomain: null,
    uploadChunkBytes: 8,
    maxConcurrentTransfers: 4,
    requestTimeoutMs: 5_000,
    keySource: 'file',
    ...overrides,
  };
}

/** Records how many tokens were minted, so an auth retry can be observed. */
class StubTokens implements AccessTokenSource {
  minted = 0;
  invalidations = 0;

  async getAccessToken(): Promise<string> {
    this.minted += 1;
    return `token-${this.minted}`;
  }

  invalidate(): void {
    this.invalidations += 1;
  }
}

interface QueuedFailure {
  status: number;
  reason?: string;
  /** When set, the failure happens *after* the server has already accepted the bytes. */
  afterCommit?: boolean;
}

/** A small, strict model of Google's resumable upload endpoint. */
class FakeUploadEndpoint {
  received = Buffer.alloc(0);
  completed = false;
  /** Every chunk body length the client actually sent, in order. */
  readonly chunkSizes: number[] = [];
  readonly contentRanges: string[] = [];
  sessionsCreated = 0;
  statusQueries = 0;

  private readonly putFailures: QueuedFailure[] = [];

  failNextPut(failure: QueuedFailure): void {
    this.putFailures.push(failure);
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (method === 'POST' && url.includes('/upload/drive/v3/files')) {
      this.sessionsCreated += 1;
      return new Response('{}', { status: 200, headers: { Location: SESSION_URI } });
    }

    if (method === 'DELETE') return new Response(null, { status: 204 });

    if (method === 'PUT' && url === SESSION_URI) return this.handlePut(init);

    return new Response('{"error":{"message":"unexpected request"}}', { status: 400 });
  };

  private handlePut(init?: RequestInit): Response {
    const headers = new Headers(init?.headers as HeadersInit);
    const contentRange = headers.get('content-range') ?? '';
    this.contentRanges.push(contentRange);

    const body = init?.body ? Buffer.from(init.body as unknown as Uint8Array) : Buffer.alloc(0);

    // `bytes * /N` — a status query or a final zero-length finalize.
    const statusQuery = /^bytes \*\/(\d+|\*)$/.exec(contentRange);
    if (statusQuery) {
      this.statusQueries += 1;
      const declared = statusQuery[1] === '*' ? null : Number(statusQuery[1]);
      if (declared !== null && this.received.length === declared) {
        this.completed = true;
        return this.fileResponse();
      }
      return this.incompleteResponse();
    }

    const parsed = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(contentRange);
    if (!parsed) return new Response('{"error":{"message":"bad Content-Range"}}', { status: 400 });

    const start = Number(parsed[1]);
    const total = parsed[3] === '*' ? null : Number(parsed[3]);

    // The real service refuses a chunk that does not begin where it left off. Modelling
    // that is the point: a client that re-sends blindly after a failure fails here rather
    // than producing a corrupt file nobody notices.
    if (start !== this.received.length) {
      return new Response('{"error":{"message":"offset mismatch"}}', { status: 400 });
    }

    const failure = this.putFailures.shift();
    if (failure && !failure.afterCommit) return this.failureResponse(failure);

    this.chunkSizes.push(body.length);
    this.received = Buffer.concat([this.received, body]);

    // A failure the client sees *after* the bytes landed: the response was lost in transit.
    // This is the case the pre-retry status query exists for.
    if (failure?.afterCommit) return this.failureResponse(failure);

    if (total !== null && this.received.length === total) {
      this.completed = true;
      return this.fileResponse();
    }
    return this.incompleteResponse();
  }

  private failureResponse(failure: QueuedFailure): Response {
    const body = JSON.stringify({
      error: { message: 'transient', errors: failure.reason ? [{ reason: failure.reason }] : [] },
    });
    return new Response(body, { status: failure.status });
  }

  private incompleteResponse(): Response {
    const headers: Record<string, string> = {};
    if (this.received.length > 0) headers.Range = `bytes=0-${this.received.length - 1}`;
    return new Response(null, { status: 308, headers });
  }

  private fileResponse(): Response {
    return new Response(
      JSON.stringify({
        id: 'drive-file-1',
        name: 'uploaded.bin',
        mimeType: 'application/octet-stream',
        size: String(this.received.length),
        md5Checksum: 'stub-md5',
        headRevisionId: 'rev-1',
        parents: ['root-folder'],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }
}

let endpoint: FakeUploadEndpoint;
let tokens: StubTokens;
let client: GoogleDriveHttpClient;
const originalFetch = globalThis.fetch;

function makeClient(overrides: Partial<DriveStorageConfig> = {}): GoogleDriveHttpClient {
  return new GoogleDriveHttpClient(config(overrides), tokens, {
    // Instant, deterministic backoff: these tests are about control flow, not wall-clock.
    sleep: async () => {},
    random: () => 0,
  });
}

beforeEach(() => {
  endpoint = new FakeUploadEndpoint();
  tokens = new StubTokens();
  globalThis.fetch = endpoint.fetch as typeof globalThis.fetch;
  client = makeClient();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function upload(content: Buffer, size?: number) {
  return client.uploadFile({
    name: 'uploaded.bin',
    parentId: 'root-folder',
    mimeType: 'application/octet-stream',
    body: Readable.from([content]),
    size: size ?? content.length,
  });
}

describe('resumable upload — chunking', () => {
  it('sends a small file as a single chunk', async () => {
    const content = Buffer.from('12345');
    const result = await upload(content);

    expect(result.id).toBe('drive-file-1');
    expect(endpoint.received).toEqual(content);
    expect(endpoint.chunkSizes).toEqual([5]);
  });

  /**
   * Bounded memory is the property that lets a multi-gigabyte file upload without the
   * server holding it. Asserting the *maximum chunk size* is how that is observable from
   * outside: no request may ever carry more than one configured chunk.
   */
  it('splits a larger file into chunks of the configured size and never exceeds it', async () => {
    const content = Buffer.from('0123456789abcdefghij'); // 20 bytes, chunk size 8
    await upload(content);

    expect(endpoint.received).toEqual(content);
    expect(endpoint.chunkSizes).toEqual([8, 8, 4]);
    expect(Math.max(...endpoint.chunkSizes)).toBeLessThanOrEqual(8);
  });

  it('reassembles a body that arrives in awkwardly sized pieces', async () => {
    const parts = [Buffer.from('ab'), Buffer.from('cdefghijk'), Buffer.from('l')];
    const expected = Buffer.concat(parts);

    const result = await client.uploadFile({
      name: 'uploaded.bin',
      parentId: 'root-folder',
      mimeType: 'application/octet-stream',
      body: Readable.from(parts),
      size: expected.length,
    });

    expect(result.id).toBe('drive-file-1');
    expect(endpoint.received).toEqual(expected);
  });

  /**
   * The boundary case that silently uploads every byte and then creates nothing if the
   * finalize step is missing: a file whose size is an exact multiple of the chunk size.
   */
  it('completes a file whose size is an exact multiple of the chunk size', async () => {
    const content = Buffer.from('0123456789abcdef'); // exactly 2 × 8
    const result = await upload(content);

    expect(result.id).toBe('drive-file-1');
    expect(endpoint.received).toEqual(content);
    expect(endpoint.completed).toBe(true);
  });

  it('completes an empty file', async () => {
    const result = await upload(Buffer.alloc(0));

    expect(result.id).toBe('drive-file-1');
    expect(endpoint.received).toHaveLength(0);
    expect(endpoint.completed).toBe(true);
  });

  it('declares the total on every chunk when the size is known', async () => {
    await upload(Buffer.from('0123456789'));
    expect(endpoint.contentRanges).toEqual(['bytes 0-7/10', 'bytes 8-9/10']);
  });

  /** An export or a stream of unknown length: only the final chunk can state the total. */
  it('uses an open-ended range until the final chunk when the size is unknown', async () => {
    await client.uploadFile({
      name: 'uploaded.bin',
      parentId: 'root-folder',
      mimeType: 'application/octet-stream',
      body: Readable.from([Buffer.from('0123456789')]),
    });

    expect(endpoint.contentRanges).toEqual(['bytes 0-7/*', 'bytes 8-9/10']);
    expect(endpoint.received).toEqual(Buffer.from('0123456789'));
  });
});

describe('resumable upload — failure and resume', () => {
  it('retries a transient chunk failure and completes', async () => {
    endpoint.failNextPut({ status: 503 });

    const content = Buffer.from('0123456789abcdefghij');
    const result = await upload(content);

    expect(result.id).toBe('drive-file-1');
    expect(endpoint.received).toEqual(content);
    // The retry asked the session where it stood before re-sending anything.
    expect(endpoint.statusQueries).toBeGreaterThan(0);
  });

  /**
   * The genuinely hard case. Drive accepted the chunk and then the response was lost — from
   * the client's side that is indistinguishable from "nothing arrived". Re-sending would
   * write those bytes a second time at an offset the server has already filled. The status
   * query before every retry is what makes the difference, and this test is the reason it
   * is there.
   */
  it('does not re-send bytes the server already accepted when a response is lost', async () => {
    endpoint.failNextPut({ status: 503, afterCommit: true });

    const content = Buffer.from('0123456789abcdefghij');
    const result = await upload(content);

    expect(result.id).toBe('drive-file-1');
    expect(endpoint.received).toEqual(content);
    // Not 24 bytes: the eight already held were not sent again.
    expect(endpoint.received).toHaveLength(20);
  });

  /**
   * The same loss on the *final* chunk. The file exists and is complete; re-uploading would
   * create a duplicate in company storage that no database row points at.
   */
  it('adopts an already-complete upload rather than creating a duplicate', async () => {
    const content = Buffer.from('01234567'); // one chunk exactly
    endpoint.failNextPut({ status: 500, afterCommit: true });

    const result = await client.uploadFile({
      name: 'uploaded.bin',
      parentId: 'root-folder',
      mimeType: 'application/octet-stream',
      body: Readable.from([content]),
      size: content.length,
    });

    expect(result.id).toBe('drive-file-1');
    expect(endpoint.sessionsCreated).toBe(1);
    expect(endpoint.received).toEqual(content);
  });

  it('mints a fresh token and retries once when the session rejects the current one', async () => {
    endpoint.failNextPut({ status: 401 });

    await upload(Buffer.from('01234'));

    expect(tokens.invalidations).toBe(1);
    expect(endpoint.received).toEqual(Buffer.from('01234'));
  });

  /**
   * A permissions failure is permanent. Retrying it five times against the whole company's
   * storage burns quota that interactive uploads share, and delays telling the user the
   * truth by however long the backoff takes.
   */
  it('does not retry a permissions failure', async () => {
    endpoint.failNextPut({ status: 403, reason: 'insufficientFilePermissions' });

    await expect(upload(Buffer.from('01234'))).rejects.toThrow();
    expect(endpoint.statusQueries).toBe(0);
  });

  it('gives up after the configured number of attempts', async () => {
    for (let i = 0; i < 10; i += 1) endpoint.failNextPut({ status: 503 });

    client = new GoogleDriveHttpClient(config(), tokens, {
      attempts: 3,
      sleep: async () => {},
      random: () => 0,
    });

    await expect(upload(Buffer.from('01234'))).rejects.toThrow();
  });
});

describe('drive failure classification', () => {
  /**
   * A 403 is genuinely ambiguous in Drive: it carries both "slow down" and "you may not do
   * that", distinguished only by `reason`. Treating an unrecognised 403 as permanent is the
   * safe direction.
   */
  it('retries rate limits and server errors, never a bare permissions failure', () => {
    expect(isRetryableDriveFailure(429, null)).toBe(true);
    expect(isRetryableDriveFailure(500, null)).toBe(true);
    expect(isRetryableDriveFailure(503, null)).toBe(true);
    expect(isRetryableDriveFailure(403, 'rateLimitExceeded')).toBe(true);
    expect(isRetryableDriveFailure(403, 'userRateLimitExceeded')).toBe(true);

    expect(isRetryableDriveFailure(403, 'insufficientFilePermissions')).toBe(false);
    expect(isRetryableDriveFailure(403, null)).toBe(false);
    expect(isRetryableDriveFailure(404, null)).toBe(false);
    expect(isRetryableDriveFailure(400, null)).toBe(false);
  });

  it('reads the reason and message out of a Drive error body', () => {
    const error = driveErrorFromResponse(
      403,
      JSON.stringify({
        error: { message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] },
      }),
    );

    expect(error.reason).toBe('rateLimitExceeded');
    expect(error.message).toBe('Rate Limit Exceeded');
    expect(error.retryable).toBe(true);
  });

  /** A proxy's HTML 502 page is exactly the failure where a parser must not itself throw. */
  it('classifies a non-JSON error body by status alone', () => {
    const error = driveErrorFromResponse(502, '<html>Bad Gateway</html>');
    expect(error.retryable).toBe(true);
    expect(error.reason).toBeNull();
  });

  it('carries Retry-After when Google sends one', () => {
    const error = driveErrorFromResponse(429, '{}', '30');
    expect(error.retryAfterSeconds).toBe(30);
  });

  /**
   * Full jitter, not a narrow wobble around an exponential curve. When a batch of
   * concurrent transfers all trip the same limit in the same second, a tight band retries
   * them together and trips it again; spreading across the whole window is what actually
   * breaks the convoy.
   */
  it('spreads backoff across the whole window and caps it', () => {
    expect(backoffDelayMs(1, { random: () => 0, baseDelayMs: 500 })).toBe(0);
    expect(backoffDelayMs(1, { random: () => 1, baseDelayMs: 500 })).toBe(500);
    expect(backoffDelayMs(3, { random: () => 1, baseDelayMs: 500 })).toBe(2000);
    expect(backoffDelayMs(20, { random: () => 1, baseDelayMs: 500, maxDelayMs: 32_000 })).toBe(32_000);
  });

  it('waits for the interval Google asked for rather than its own guess', async () => {
    const slept: number[] = [];
    let attempts = 0;

    await withDriveRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new DriveApiError({ status: 429, message: 'slow down', retryAfterSeconds: 7 });
        }
        return 'done';
      },
      { sleep: async (ms) => void slept.push(ms), random: () => 1 },
    );

    expect(slept).toEqual([7000]);
  });

  it('does not retry a non-Drive error at all', async () => {
    let attempts = 0;
    await expect(
      withDriveRetry(
        async () => {
          attempts += 1;
          throw new TypeError('programming error');
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow(TypeError);

    expect(attempts).toBe(1);
  });
});
