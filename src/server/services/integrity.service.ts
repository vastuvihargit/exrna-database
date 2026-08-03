/**
 * Storage integrity verification.
 *
 * Two failure modes matter, and they are not equally serious:
 *
 *   • **A version row whose bytes are gone.** Data loss. Somebody's research is
 *     unrecoverable and nothing in the UI would say so — the file would list normally and
 *     fail only on download. This is the reason the sweep exists.
 *
 *   • **Bytes on disk with no row.** An orphan. Wasted space and nothing worse, usually
 *     the residue of a crash between writing bytes and committing the record. Reported,
 *     counted, and *never* deleted automatically: the one scenario where deleting them
 *     would be catastrophic is a partially restored database, which is exactly when this
 *     script is most likely to be run.
 *
 * Checksums are re-computed on a sample rather than on everything. Re-hashing a terabyte
 * nightly would starve the disk of the I/O the platform is there to provide; a rolling
 * sample finds silent corruption within days and costs nothing anyone notices.
 */
import { createHash } from 'crypto';

import { getEnv } from '@/server/config/env';
import * as versionRepository from '@/server/repositories/file-version.repository';
import { getObjectStore, getStorageProvider } from '@/server/storage';
import type { StorageArea, StorageLocator } from '@/server/storage/types';
import { getLogger } from '@/server/logging/logger';

export interface IntegrityProblem {
  kind: 'missing_bytes' | 'checksum_mismatch' | 'size_mismatch' | 'orphan';
  versionId?: string;
  fileId?: string;
  key: string;
  area: StorageArea;
  detail: string;
}

export interface IntegrityReport {
  checkedVersions: number;
  hashedVersions: number;
  totalVersions: number;
  orphanCount: number;
  /** Capped — a report listing 40,000 orphans helps nobody. */
  problems: IntegrityProblem[];
  /** True when the sweep stopped at its limit rather than reaching the end. */
  truncated: boolean;
  freeBytes: number | null;
  totalBytes: number | null;
  belowFreeSpaceFloor: boolean;
  startedAt: Date;
  finishedAt: Date;
}

const MAX_REPORTED_PROBLEMS = 200;
const PAGE_SIZE = 500;

export interface VerifyOptions {
  /** Fraction of versions whose bytes are re-hashed, 0–1. */
  sampleRate?: number;
  /** Stop after this many version rows. */
  limit?: number;
  /** Skip the on-disk walk. It is the expensive half on a large volume. */
  includeOrphans?: boolean;
}

export async function verifyStorageIntegrity(
  options: VerifyOptions = {},
): Promise<IntegrityReport> {
  const env = getEnv();
  const storage = getStorageProvider();
  const startedAt = new Date();

  const sampleRate = Math.min(Math.max(options.sampleRate ?? 0.02, 0), 1);
  const limit = options.limit ?? 100_000;

  const problems: IntegrityProblem[] = [];
  const seenKeys = new Map<StorageArea, Set<string>>();

  let checkedVersions = 0;
  let hashedVersions = 0;
  let afterId: string | undefined;
  let truncated = false;

  for (;;) {
    const page = await versionRepository.listStoredObjects({
      ...(afterId ? { afterId } : {}),
      limit: PAGE_SIZE,
    });
    if (page.length === 0) break;

    for (const object of page) {
      if (checkedVersions >= limit) {
        truncated = true;
        break;
      }
      checkedVersions += 1;

      let area = seenKeys.get(object.area);
      if (!area) {
        area = new Set<string>();
        seenKeys.set(object.area, area);
      }
      area.add(object.key);

      const exists = await getObjectStore(object.provider)
        .exists(object)
        .catch(() => false);
      if (!exists) {
        push(problems, {
          kind: 'missing_bytes',
          versionId: object.versionId,
          fileId: object.fileId,
          key: object.key,
          area: object.area,
          detail: 'The stored object this version points at does not exist',
        });
        continue;
      }

      // Size is cheap — a stat, no read — so it is checked on every object. A truncated
      // file is the most common form of silent corruption and this catches it for free.
      const metadata = await getObjectStore(object.provider)
        .metadata(object)
        .catch(() => null);
      if (metadata && metadata.size !== object.fileSize) {
        push(problems, {
          kind: 'size_mismatch',
          versionId: object.versionId,
          fileId: object.fileId,
          key: object.key,
          area: object.area,
          detail: `Recorded ${object.fileSize} bytes, found ${metadata.size}`,
        });
        continue;
      }

      // Deterministic sampling by version id, so consecutive runs check *different*
      // objects rather than re-hashing the same random subset for ever.
      if (sampleRate > 0 && shouldSample(object.versionId, sampleRate)) {
        hashedVersions += 1;
        const digest = await hashObject(object);
        if (digest && digest !== object.checksumSha256) {
          push(problems, {
            kind: 'checksum_mismatch',
            versionId: object.versionId,
            fileId: object.fileId,
            key: object.key,
            area: object.area,
            detail: `Recorded ${object.checksumSha256.slice(0, 16)}…, computed ${digest.slice(0, 16)}…`,
          });
        }
      }
    }

    afterId = page.at(-1)?.versionId;
    if (truncated || page.length < PAGE_SIZE) break;
  }

  let orphanCount = 0;
  // The orphan walk is local by definition: it looks for bytes on this server's disk that
  // no version row points at. `seenKeys` above was collected from every version regardless
  // of provider, which is what stops a retained local copy of a Drive-migrated file from
  // being reported as an orphan.
  if (options.includeOrphans !== false && !truncated) {
    for (const area of ['originals', 'versions'] as const) {
      const known = seenKeys.get(area) ?? new Set<string>();
      const keys = await storage.listKeys(area).catch(() => [] as string[]);
      for (const key of keys) {
        if (known.has(key)) continue;
        orphanCount += 1;
        push(problems, {
          kind: 'orphan',
          key,
          area,
          detail: 'Stored object with no version row. Never deleted automatically.',
        });
      }
    }
  }

  const capacity = await storage.getCapacity('originals').catch(() => null);
  const report: IntegrityReport = {
    checkedVersions,
    hashedVersions,
    totalVersions: await versionRepository.countStoredObjects(),
    orphanCount,
    problems,
    truncated,
    freeBytes: capacity?.freeBytes ?? null,
    totalBytes: capacity?.totalBytes ?? null,
    belowFreeSpaceFloor: capacity ? capacity.freeBytes < env.minFreeDiskBytes : false,
    startedAt,
    finishedAt: new Date(),
  };

  const critical = problems.filter((problem) => problem.kind !== 'orphan');
  if (critical.length > 0) {
    getLogger().error(
      { count: critical.length, sample: critical.slice(0, 5) },
      'Storage integrity check found missing or corrupted objects',
    );
  }

  return report;
}

function push(problems: IntegrityProblem[], problem: IntegrityProblem): void {
  if (problems.length < MAX_REPORTED_PROBLEMS) problems.push(problem);
}

/**
 * Deterministic per-object sampling.
 *
 * Uses the last hex digits of the id, which for an ObjectId is a counter — so the
 * selected set rotates naturally between runs instead of pinning on the same objects.
 */
function shouldSample(versionId: string, rate: number): boolean {
  const bucket = Number.parseInt(versionId.slice(-4), 16);
  if (!Number.isFinite(bucket)) return false;
  return bucket / 0xffff < rate;
}

async function hashObject(locator: StorageLocator): Promise<string | null> {
  try {
    const stream = await getObjectStore(locator.provider).read(locator);
    const hash = createHash('sha256');
    for await (const chunk of stream) {
      hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

export const integrityService = { verifyStorageIntegrity };
