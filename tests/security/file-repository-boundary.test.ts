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

async function seedVersion(
  fileId: string,
  googleDriveFileId: string | null,
  organizationId: Types.ObjectId = ORG,
): Promise<void> {
  const { FileVersionModel } = await import('@/server/db/models');
  await FileVersionModel.create([
    {
      organizationId,
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

  it('selects the D1 repository, not MongoDB, once the flag is set', async () => {
    const facade = await import('@/server/repositories/file.repository');
    const d1 = await import('@/server/repositories/file.repository.d1');
    const mongo = await import('@/server/repositories/file.repository.mongo');

    expect(facade.d1FileRepository).toBe(d1.d1FileRepository);
    expect(facade.mongoFileRepository).toBe(mongo.mongoFileRepository);
    // The two are genuinely different objects, so "routed to D1" is a claim with content.
    expect(facade.d1FileRepository).not.toBe(facade.mongoFileRepository);
  });

  /**
   * The no-fallback guarantee, asserted where it is cheapest to assert.
   *
   * This suite has MongoDB and no D1 binding. With the flag set, every call therefore reaches
   * the D1 repository and fails at `getD1()` — which is exactly the point: a façade that
   * silently fell back would return the MongoDB row instead, and the test would see a file
   * rather than a rejection. The D1 repository's own behaviour is proved against a real D1 in
   * `tests/d1/file-repository.test.ts`.
   */
  it('never falls back to MongoDB when D1 cannot answer', async () => {
    const facade = await import('@/server/repositories/file.repository');
    const { D1BindingUnavailableError } = await import('@/server/db/d1-context');
    const fileId = await seedFile();

    // Readable on the default path first, so the failures below are the flag and not a
    // missing fixture.
    expect(await facade.findById(actor(), fileId)).not.toBeNull();

    setDataSourceOverride('files', 'd1');
    await expect(facade.findById(actor(), fileId)).rejects.toBeInstanceOf(
      D1BindingUnavailableError,
    );
    // A write must not fall back either.
    await expect(facade.updateById(fileId, { displayName: 'x' })).rejects.toBeInstanceOf(
      D1BindingUnavailableError,
    );
    // Nor an authorization bypass, which is the path a background job would take.
    await expect(facade.findByIdInternal(fileId)).rejects.toBeInstanceOf(
      D1BindingUnavailableError,
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

  it('resolves across organizations, because the Drive id space is not per-organization', async () => {
    const facade = await import('@/server/repositories/file.repository');
    const fileId = await seedFile({ organizationId: OTHER_ORG, ownerId: STRANGER });
    await seedVersion(fileId, 'drive-other-org', OTHER_ORG);

    // Asserted rather than assumed, because it is the one place in this contract where an
    // organization filter is deliberately absent. A Google Drive id is unique across the whole
    // mirror — the unique index on `file_versions.googleDriveFileId` carries no organization
    // component — and the change feed starts from a Drive id with no organization in hand. Were
    // this scoped, a change for another tenant's file would resolve to null, be filed as an
    // unmanaged item, and the mirror's disagreement would go unreported.
    //
    // Isolation is therefore the caller's obligation, not this lookup's, and the record carries
    // the `organizationId` a caller needs to discharge it. `findByDriveFileIdInternal` is an
    // authorization bypass reached only by the sync worker; no user-facing route reaches it,
    // which the architectural assertions below enforce.
    const found = await facade.findByDriveFileIdInternal('drive-other-org');
    expect(found?.id).toBe(fileId);
    expect(found?.organizationId).toBe(String(OTHER_ORG));
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

  /**
   * The D1 repository has to run inside `workerd`, which has no Mongoose and no Node built-ins
   * beyond the `nodejs_compat` set.
   *
   * A single `import` of the Mongo implementation would be enough to pull the whole Mongoose
   * driver into the module graph — and it would not fail the build, only bloat the Worker and
   * fail at runtime the first time something touched a connection. Asserted statically because
   * the failure it prevents is invisible until deployment.
   *
   * `AmbiguousDriveFileError` lives in the contract for exactly this reason: both engines raise
   * it, and the contract's only foreign import is a `ClientSession` *type*, which erases.
   */
  it('the D1 file repository pulls in neither Mongoose nor the Mongo implementation', async () => {
    const source = await fsp.readFile(
      path.resolve(process.cwd(), 'src', 'server', 'repositories', 'file.repository.d1.ts'),
      'utf8',
    );

    const imports = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map((match) => match[1]!);

    expect(imports.filter((specifier) => /mongoose|\.mongo$|db\/connection/.test(specifier))).toEqual(
      [],
    );
    expect(
      imports.filter((specifier) => specifier.startsWith('node:')),
      'a node: import would not resolve in workerd',
    ).toEqual([]);
  });

  /** The contract is imported by the D1 side, so it must stay free of runtime Mongo too. */
  it('the contract imports Mongoose only as a type', async () => {
    const source = await fsp.readFile(
      path.resolve(process.cwd(), 'src', 'server', 'repositories', 'file.repository.contract.ts'),
      'utf8',
    );

    const mongooseImports = [...source.matchAll(/^import\s+(type\s+)?.*from ['"]mongoose['"]/gm)];
    expect(mongooseImports).toHaveLength(1);
    // `import type` is erased entirely; a value import would put the driver in the bundle.
    expect(mongooseImports[0]![1], 'must be `import type`').toBeTruthy();
  });

  /**
   * The same three rules for the version module, which arrived after the ones above.
   *
   * The version repository is reached from the *upload* path, so a Node-only import here would
   * fail on the busiest write in the product, and only once deployed.
   */
  const workerSafe = [
    'file-version.repository.d1.ts',
    'file-version.validator.d1.ts',
  ] as const;

  for (const filename of workerSafe) {
    it(`${filename} pulls in neither Mongoose nor Node built-ins`, async () => {
      const source = await fsp.readFile(
        path.resolve(process.cwd(), 'src', 'server', 'repositories', filename),
        'utf8',
      );
      const imports = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map((match) => match[1]!);

      expect(
        imports.filter((specifier) => /mongoose|\.mongo$|db\/connection|db\/models/.test(specifier)),
        'a Mongo import would pull the whole driver into the Worker bundle',
      ).toEqual([]);
      expect(
        imports.filter((specifier) => specifier.startsWith('node:')),
        'a node: import would not resolve in workerd',
      ).toEqual([]);
    });
  }

  it('the file-version contract imports Mongoose only as a type', async () => {
    const source = await fsp.readFile(
      path.resolve(
        process.cwd(),
        'src',
        'server',
        'repositories',
        'file-version.repository.contract.ts',
      ),
      'utf8',
    );

    const mongooseImports = [...source.matchAll(/^import\s+(type\s+)?.*from ['"]mongoose['"]/gm)];
    expect(mongooseImports).toHaveLength(1);
    expect(mongooseImports[0]![1], 'must be `import type`').toBeTruthy();
  });

  /**
   * The contract also reaches for `ProcessingStatus` and `VersionLabel`, which live in the
   * Mongoose *model* file. A value import of that would drag a schema — and therefore the
   * driver — into the Worker; a type import erases. Worth pinning, because the specifier looks
   * innocuous next to the others.
   */
  it('the file-version contract imports the model file only as a type', async () => {
    const source = await fsp.readFile(
      path.resolve(
        process.cwd(),
        'src',
        'server',
        'repositories',
        'file-version.repository.contract.ts',
      ),
      'utf8',
    );

    const modelImports = [
      ...source.matchAll(/^import\s+(type\s+)?.*from ['"][^'"]*file-version\.model['"]/gm),
    ];
    expect(modelImports).toHaveLength(1);
    expect(modelImports[0]![1], 'must be `import type`').toBeTruthy();
  });
});
