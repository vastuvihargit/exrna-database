/**
 * The file repository boundary: routing, the internal/user-facing split, and the Drive lookup.
 *
 * Module 6 moves the file repository behind a database-neutral contract. Three properties of
 * that boundary are security properties rather than refactoring details, and each is asserted
 * here rather than assumed:
 *
 *   1. **MongoDB stays the default, and asking for D1 fails loudly.** The D1 implementation
 *      does not exist yet. A flag that silently served MongoDB while the logs said "files: d1"
 *      would make a soak test worthless and the mistake would surface later, against the wrong
 *      database.
 *   2. **The permission-aware lookup is actually permission-aware.** `findById` used to take no
 *      actor and return any row in the database. If that regressed, every caller that trusts it
 *      would silently start reading rows the actor has no route to.
 *   3. **The Drive lookup resolves through `file_versions` and refuses to guess.** No Drive id
 *      is stored on a file, and a Drive id claimed by two files means the mirror has diverged —
 *      picking one arbitrarily would file a change against the wrong research record.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { startTestDb, stopTestDb, type TestDb } from '../helpers/test-db';
import {
  clearDataSourceOverrides,
  dataSourceFor,
  envVarFor,
  setDataSourceOverride,
} from '@/server/repositories/data-source';
import type { Actor } from '@/server/permissions/actor';

let db: TestDb;

const ORG = new Types.ObjectId();
const OTHER_ORG = new Types.ObjectId();
const OWNER = new Types.ObjectId();
const STRANGER = new Types.ObjectId();
const FOLDER = new Types.ObjectId();

beforeAll(async () => {
  db = await startTestDb();
  if (!db.available) {
    throw new Error(`This suite asserts a security rule and needs a database: ${db.reason}`);
  }
}, 180_000);

afterAll(async () => {
  clearDataSourceOverrides();
  await stopTestDb();
});

afterEach(() => {
  clearDataSourceOverrides();
});

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: String(OWNER),
    organizationId: String(ORG),
    departmentId: null,
    projectIds: [],
    grants: [],
    isSuperAdmin: false,
    ...overrides,
  } as Actor;
}

/** A file row written straight to the collection, so the test controls every field. */
async function seedFile(
  overrides: Partial<Record<string, unknown>> = {},
): Promise<string> {
  const { FileModel } = await import('@/server/db/models');
  const id = new Types.ObjectId();
  await FileModel.create([
    {
      _id: id,
      organizationId: ORG,
      displayName: 'result.pdf',
      displayNameLower: 'result.pdf',
      originalFilename: 'result.pdf',
      extension: 'pdf',
      category: 'document',
      folderId: FOLDER,
      folderPathAncestors: [FOLDER],
      driveType: 'my',
      ownerId: OWNER,
      departmentId: null,
      projectId: null,
      confidentiality: 'internal',
      sizeBytes: 10,
      mimeType: 'application/pdf',
      checksumSha256: 'c'.repeat(64),
      createdBy: OWNER,
      ...overrides,
    },
  ]);
  return String(id);
}

async function seedVersion(fileId: string, googleDriveFileId: string | null): Promise<void> {
  const { FileVersionModel } = await import('@/server/db/models');
  await FileVersionModel.create([
    {
      organizationId: ORG,
      fileId: new Types.ObjectId(fileId),
      versionNumber: 1,
      storageKey: `originals/${fileId}/v1`,
      storageArea: 'originals',
      originalFilename: 'result.pdf',
      fileSize: 10,
      mimeType: 'application/pdf',
      extension: 'pdf',
      checksumSha256: 'c'.repeat(64),
      uploadedBy: OWNER,
      ...(googleDriveFileId ? { googleDriveFileId } : {}),
    },
  ]);
}

/* ================================================================== routing */

describe('file repository routing', () => {
  it('defaults to MongoDB, and moves only the files module when asked', () => {
    expect(dataSourceFor('files')).toBe('mongo');

    setDataSourceOverride('files', 'd1');
    expect(dataSourceFor('files')).toBe('d1');
    // One flag, one module: the others stay where they are.
    expect(dataSourceFor('folders')).toBe('mongo');
    expect(dataSourceFor('users')).toBe('mongo');

    clearDataSourceOverrides();
    expect(dataSourceFor('files')).toBe('mongo');
  });

  it('the flag name follows the established convention', () => {
    expect(envVarFor('files')).toBe('DATA_SOURCE_FILES');
  });

  it('treats an explicit "mongo" and an unrecognised value alike', () => {
    setDataSourceOverride('files', 'mongo');
    expect(dataSourceFor('files')).toBe('mongo');

    // Not a loose truthy match: only the exact string moves a module.
    clearDataSourceOverrides();
    const previous = process.env.DATA_SOURCE_FILES;
    for (const value of ['D1', 'true', '1', 'yes', 'd1 ', '']) {
      process.env.DATA_SOURCE_FILES = value;
      expect(dataSourceFor('files'), `"${value}" must not select D1`).toBe('mongo');
    }
    if (previous === undefined) delete process.env.DATA_SOURCE_FILES;
    else process.env.DATA_SOURCE_FILES = previous;
  });

  it('refuses to serve MongoDB when D1 was asked for', async () => {
    const facade = await import('@/server/repositories/file.repository');
    const fileId = await seedFile();

    // Proves the row is readable on the default path first, so the failure below is the
    // flag and not a missing fixture.
    expect(await facade.findById(actor(), fileId)).not.toBeNull();

    setDataSourceOverride('files', 'd1');
    await expect(facade.findById(actor(), fileId)).rejects.toBeInstanceOf(
      facade.D1FileRepositoryUnavailableError,
    );
    // A write must not fall back either.
    await expect(facade.updateById(fileId, { displayName: 'x' })).rejects.toBeInstanceOf(
      facade.D1FileRepositoryUnavailableError,
    );
  });
});

/* ================================================================== the actor boundary */

describe('the permission-aware lookup', () => {
  it('refuses a file the actor has been explicitly denied, however well they guess the id', async () => {
    const facade = await import('@/server/repositories/file.repository');
    const fileId = await seedFile({
      permissions: [
        { principalType: 'user', principalId: STRANGER, accessLevel: 'viewer', deny: true },
      ],
    });

    expect(await facade.findById(actor(), fileId)).not.toBeNull();

    const denied = actor({ userId: String(STRANGER) });
    expect(await facade.findById(denied, fileId)).toBeNull();
    expect(await facade.findByIds(denied, [fileId])).toEqual([]);
  });

  /**
   * The limit of what the MongoDB lookup can promise, asserted so it is a decision rather than
   * a discovery.
   *
   * A same-organization actor with no grant *does* load the row here: MongoDB cannot check an
   * inherited grant inside a `find` filter, so the lookup applies only the two guards that
   * `canAccess` also implies (see `lookupGuardFilter`). Narrowing it further would 404 the
   * ordinary case of opening a file inside a folder somebody shared.
   *
   * The refusal therefore comes from `assertCan`, one call later, with the full ancestor chain —
   * which is what this asserts. The predicate moves *into* the query with D1, where
   * `file_folder_ancestors` makes inheritance expressible.
   */
  it('leaves the no-grant case to assertCan, which refuses it', async () => {
    const facade = await import('@/server/repositories/file.repository');
    const { requireFile } = await import('@/server/services/file-access');
    const fileId = await seedFile();

    const stranger = actor({ userId: String(STRANGER) });
    expect(await facade.findById(stranger, fileId)).not.toBeNull();

    await expect(requireFile(stranger, fileId, 'file.view')).rejects.toMatchObject({
      status: expect.any(Number),
    });
  });

  it('refuses across organizations, super admin included', async () => {
    const facade = await import('@/server/repositories/file.repository');
    const fileId = await seedFile();

    const foreignAdmin = actor({
      userId: String(STRANGER),
      organizationId: String(OTHER_ORG),
      isSuperAdmin: true,
    });
    expect(await facade.findById(foreignAdmin, fileId)).toBeNull();
  });

  it('still hands the unfiltered row to the internal lookup', async () => {
    const facade = await import('@/server/repositories/file.repository');
    const fileId = await seedFile();

    // The bypass exists for the Drive feed and the retention purge, and it is the *only*
    // way to read a row no actor can reach.
    expect(await facade.findByIdInternal(fileId)).not.toBeNull();
  });
});

/* ================================================================== the Drive lookup */

describe('findByDriveFileIdInternal', () => {
  it('resolves a Drive id through file_versions to the owning file', async () => {
    const facade = await import('@/server/repositories/file.repository');
    const fileId = await seedFile();
    await seedVersion(fileId, 'drive-abc');

    const found = await facade.findByDriveFileIdInternal('drive-abc');
    expect(found?.id).toBe(fileId);
  });

  it('returns null for a Drive id nothing has claimed', async () => {
    const facade = await import('@/server/repositories/file.repository');
    expect(await facade.findByDriveFileIdInternal('drive-unknown')).toBeNull();
    expect(await facade.findByDriveFileIdInternal('')).toBeNull();
  });

  it('still resolves a file that has been trashed here', async () => {
    const facade = await import('@/server/repositories/file.repository');
    const fileId = await seedFile({ deletedAt: new Date(), status: 'trashed' });
    await seedVersion(fileId, 'drive-trashed');

    // Deliberate: a change arriving for a file trashed on this side is still *ours*, and
    // treating it as unmanaged would hide the mirror's disagreement instead of reporting it.
    const found = await facade.findByDriveFileIdInternal('drive-trashed');
    expect(found?.id).toBe(fileId);
    expect(found?.deletedAt).not.toBeNull();
  });

  it('fails deterministically when one Drive id is claimed by two files', async () => {
    const facade = await import('@/server/repositories/file.repository');
    const { AmbiguousDriveFileError } = await import(
      '@/server/repositories/file.repository.mongo'
    );

    const first = await seedFile();
    const second = await seedFile();
    // The unique partial index is what normally prevents this; it is dropped for this one
    // assertion because the question is what the repository does when the data is already
    // wrong, not whether the index works.
    const { FileVersionModel } = await import('@/server/db/models');
    await FileVersionModel.collection.dropIndexes().catch(() => undefined);
    await seedVersion(first, 'drive-dup');
    await seedVersion(second, 'drive-dup');

    await expect(facade.findByDriveFileIdInternal('drive-dup')).rejects.toBeInstanceOf(
      AmbiguousDriveFileError,
    );

    await FileVersionModel.syncIndexes().catch(() => undefined);
  });
});

/* ================================================================== architecture */

describe('the internal/user-facing split is structural', () => {
  async function walk(dir: string): Promise<string[]> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.isFile() && /\.tsx?$/.test(entry.name) ? [full] : [];
      }),
    );
    return files.flat();
  }

  it('no API route imports a repository implementation directly', async () => {
    const root = path.resolve(process.cwd(), 'src', 'app');
    const files = await walk(root);

    const offenders: string[] = [];
    for (const file of files) {
      const source = await fsp.readFile(file, 'utf8');
      // The façade is the only permitted entry point: importing `.mongo` or `.d1` would
      // pin a route to one database and skip the routing flag entirely.
      if (/from ['"][^'"]*(file|folder)\.repository\.(mongo|d1)['"]/.test(source)) {
        offenders.push(path.relative(root, file));
      }
    }

    expect(
      offenders,
      `API routes must go through the repository façade: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('no API route calls an authorization bypass', async () => {
    const root = path.resolve(process.cwd(), 'src', 'app');
    const files = await walk(root);

    const offenders: string[] = [];
    for (const file of files) {
      const source = await fsp.readFile(file, 'utf8');
      if (/\b\w+Internal\s*\(/.test(source)) offenders.push(path.relative(root, file));
    }

    expect(
      offenders,
      `Internal lookups bypass authorization and must stay in trusted services: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
