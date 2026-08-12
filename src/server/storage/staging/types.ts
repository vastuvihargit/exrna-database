/**
 * Upload staging — where bytes sit while they are still untrusted.
 *
 * ── Why this interface exists ───────────────────────────────────────────────────────────
 *
 * `upload.service.ts` used to call `getStorageProvider()` in eight places, and
 * `getStorageProvider()` *is* the local filesystem. That made the upload pipeline the one
 * request path a Cloudflare Worker could not run — not because of a scattering of `fs` calls,
 * but because the pipeline's shape assumed a disk: stream to quarantine, read the head back
 * off disk, scan the quarantined object, rename it into `originals`, and only then mirror to
 * Google Drive. Drive was a mirror *after* a local write.
 *
 * A staging backend is that shape, stated as an interface, so there can be two of it. The
 * local one is the pipeline that has been serving production, unchanged. The Drive one stages
 * into a resumable upload in a staging folder and promotes by re-parenting — a metadata change
 * in Drive, not a byte copy.
 *
 * ── The four properties that must survive either implementation ─────────────────────────
 *
 * 1. **Nothing is accepted before permission, type and quota are decided.** That all happens
 *    in `authorizeUpload`, above this interface, and neither backend is reachable before it.
 * 2. **Size and checksum are what the server measured**, never what the client declared. Both
 *    backends hash in a passthrough over the bytes they actually received, and `StagedContent`
 *    has no field a client-supplied value could be written to.
 * 3. **Unverified bytes are never at an address a download endpoint can resolve.** Locally
 *    that is the quarantine area; in Drive it is a staging folder that no `file_versions` row
 *    points at until `promote` succeeds. Application ACL is authoritative in both cases — a
 *    Drive id is never a capability.
 * 4. **A failure leaves no half-file and no orphan record.** `discard` is idempotent and is
 *    called on every abandoned path.
 */
import type { StorageArea, StorageProviderName } from '../types';

/** What the server measured while the bytes went past. Never a client-declared value. */
export interface StagedContent {
  size: number;
  /** Lower-case hex SHA-256, computed in a passthrough during the transfer. */
  checksumSha256: string;
}

/**
 * The subset of an upload session a staging backend may see.
 *
 * Deliberately not the whole `UploadSessionRecord`: staging has no business reading the actor,
 * the destination folder or the authorization fields, and passing a narrower shape is what
 * stops it growing a second opinion about any of them.
 */
export interface StagingSession {
  id: string;
  resolvedMimeType: string;
  declaredSize: number;
  chunkSize: number;
  totalChunks: number;
  receivedChunks: number[];
  /** Local staging only. */
  quarantineKey: string | null;
  /** External staging only — see migration 0005. */
  externalUploadUri: string | null;
  externalStagedId: string | null;
}

/**
 * Handles a backend learned during `receive`/`receiveChunk` that must be persisted on the
 * session, because `finalize` arrives as a separate HTTP request.
 *
 * `undefined` means "unchanged"; an explicit `null` means "clear". They differ, and the
 * difference matters: clearing the staged id after promotion is what stops a later cleanup
 * sweep deleting the object the file now points at.
 */
export interface StagingHandles {
  quarantineKey?: string | null;
  externalUploadUri?: string | null;
  externalStagedId?: string | null;
}

export type StagedOutcome = StagedContent & { handles: StagingHandles };

/** Where a promoted object should end up, in application terms. */
export interface PromotionTarget {
  organizationId: string;
  departmentId: string | null;
  /** The application folder. The Drive backend mirrors the path to it; the local one ignores it. */
  folderId: string;
  fileId: string;
  /** The generated physical id for this version. Never the user's filename. */
  versionId: string;
  displayName: string;
  contentType: string;
  sizeBytes: number;
}

/**
 * What was recorded, in the shape `CreateVersionInput` wants.
 *
 * `key` and `area` are always present, including for a Drive-backed object. That is not
 * vestigial: the local address is the half of `StorageLocator` that never gets cleared, and
 * keeping it populated is what makes reverting a version to local storage a field flip rather
 * than a data movement. For a Drive-native upload it names a location that holds no bytes yet,
 * which is exactly what a byte-migration in the other direction would fill.
 */
export interface PromotedObject {
  provider: StorageProviderName;
  key: string;
  area: StorageArea;
  externalId?: string;
  externalParentId?: string;
  externalRevisionId?: string;
  externalWebViewLink?: string;
  checksumMd5?: string;
}

export interface UploadStagingBackend {
  readonly provider: StorageProviderName;

  /**
   * Refuses an upload the backend has no room for.
   *
   * Local checks the volume's free-space floor. Drive does not implement a pre-flight quota
   * query and says so by succeeding: Google enforces its own quota and reports it as an upload
   * failure, and guessing at headroom we cannot measure would be a check that always passes
   * while looking like one that does not.
   */
  assertHeadroom(bytes: number): Promise<void>;

  /** Single-shot: the whole body, measured as it goes past. */
  receive(input: {
    session: StagingSession;
    body: NodeJS.ReadableStream;
    displayName: string;
  }): Promise<StagedOutcome>;

  /**
   * One chunk of a resumable upload.
   *
   * `expectedOffset` is where this chunk starts, computed by the caller from the agreed chunk
   * size. Backends that stage into a provider-side resumable session need it; the local one
   * addresses chunks by index and ignores it.
   *
   * Returns the content only once the upload is complete — for the local backend that is never
   * (assembly happens in `assemble`), for a provider-side session it is the final chunk.
   */
  receiveChunk(input: {
    session: StagingSession;
    chunkIndex: number;
    expectedOffset: number;
    chunk: Buffer;
    displayName: string;
  }): Promise<{ complete: StagedContent | null; handles: StagingHandles }>;

  /**
   * Turns the received chunks into one staged object, if that is not already what they are.
   *
   * The local backend concatenates its per-chunk objects. A provider-side resumable session is
   * already one object by the time the last chunk lands, so this re-reports what it measured.
   */
  assemble(session: StagingSession): Promise<StagedOutcome>;

  /** Whether staged content is actually there. A finalize with nothing staged is a conflict. */
  exists(session: StagingSession): Promise<boolean>;

  /** The first `bytes` of the staged content, for the file-signature check. */
  readHead(session: StagingSession, bytes: number): Promise<Buffer>;

  /** The whole staged content, for the malware scanner. */
  openRead(session: StagingSession): Promise<NodeJS.ReadableStream>;

  /** Moves the staged content to its durable home. The moment it stops being untrusted. */
  promote(session: StagingSession, target: PromotionTarget): Promise<PromotedObject>;

  /**
   * Removes everything staged for this session. Idempotent, and never throws for a missing
   * object — it is called on failure paths where throwing would mask the real error.
   */
  discard(session: StagingSession): Promise<void>;
}
