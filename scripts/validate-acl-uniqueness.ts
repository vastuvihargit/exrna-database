/**
 * Reports MongoDB folders and files whose ACL arrays cannot be copied into D1 unchanged.
 *
 * D1 constrains `resource_permissions` to one entry per principal per resource; MongoDB's
 * embedded array does not. A Phase 5 migration that copied the array would either fail on the
 * unique index or, if written to tolerate that, keep whichever entry came first and silently
 * drop the rest — and if the dropped one is a denial, the migration grants access nobody
 * granted.
 *
 * **This script is read-only.** It never writes to MongoDB. The resolution it prints is the
 * one `resolveEntries()` will apply during migration, so the report a human reviews and the
 * value the migration writes come from the same function.
 *
 *   npm run acl:validate            -- human-readable summary
 *   npm run acl:validate -- --json  -- machine-readable, for the migration audit report
 *
 * Exit code is 0 even when conflicts are found: this is a report, not a gate. It is the
 * migration that must refuse to proceed silently, and it has the same data to do it with.
 */
import { connectToDatabase } from '@/server/db/connection';
import { FolderModel, FileModel } from '@/server/db/models';
import {
  findAclConflicts,
  type AclConflict,
  type AclEntryLike,
} from '@/server/permissions/acl-normalization';

/**
 * Mongoose sub-documents carry ObjectIds and Mongoose Dates; the rules speak strings and Dates.
 * Converting here keeps `acl-normalization.ts` free of any Mongo type, so the Phase 5 migration
 * and the D1 side can both call it.
 */
function toEntries(raw: unknown): AclEntryLike[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const entry = item as {
      principalType?: unknown;
      principalId?: unknown;
      accessLevel?: unknown;
      deny?: unknown;
      expiresAt?: unknown;
    };
    return {
      principalType: String(entry.principalType ?? ''),
      principalId: String(entry.principalId ?? ''),
      accessLevel: String(entry.accessLevel ?? ''),
      deny: entry.deny === true,
      expiresAt: entry.expiresAt instanceof Date ? entry.expiresAt : null,
    };
  });
}

interface ResourceReport {
  resourceType: 'folder' | 'file';
  resourceId: string;
  organizationId: string;
  name: string;
  conflicts: AclConflict[];
}

interface Summary {
  scanned: { folders: number; files: number };
  affected: ResourceReport[];
  totals: Record<string, number>;
}

async function scan(): Promise<Summary> {
  await connectToDatabase();

  const affected: ResourceReport[] = [];
  const totals: Record<string, number> = {};
  const now = Date.now();

  const count = (kind: string) => {
    totals[kind] = (totals[kind] ?? 0) + 1;
  };

  // `withDeleted` on purpose: a trashed folder can be restored, and its ACL migrates with it.
  const folderCursor = FolderModel.find({ 'permissions.0': { $exists: true } })
    .setOptions({ withDeleted: true })
    .select({ _id: 1, organizationId: 1, name: 1, permissions: 1 })
    .lean()
    .cursor();

  let folders = 0;
  for await (const doc of folderCursor) {
    folders += 1;
    const conflicts = findAclConflicts(toEntries(doc.permissions), now);
    if (conflicts.length === 0) continue;
    conflicts.forEach((conflict) => conflict.kinds.forEach(count));
    affected.push({
      resourceType: 'folder',
      resourceId: String(doc._id),
      organizationId: String(doc.organizationId),
      name: String(doc.name),
      conflicts,
    });
  }

  const fileCursor = FileModel.find({ 'permissions.0': { $exists: true } })
    .setOptions({ withDeleted: true })
    .select({ _id: 1, organizationId: 1, displayName: 1, permissions: 1 })
    .lean()
    .cursor();

  let files = 0;
  for await (const doc of fileCursor) {
    files += 1;
    const conflicts = findAclConflicts(toEntries(doc.permissions), now);
    if (conflicts.length === 0) continue;
    conflicts.forEach((conflict) => conflict.kinds.forEach(count));
    affected.push({
      resourceType: 'file',
      resourceId: String(doc._id),
      organizationId: String(doc.organizationId),
      name: String((doc as { displayName?: string }).displayName ?? ''),
      conflicts,
    });
  }

  return { scanned: { folders, files }, affected, totals };
}

function print(summary: Summary): void {
  const { scanned, affected, totals } = summary;

  console.log('ACL uniqueness validation (read-only)\n');
  console.log(`Scanned  ${scanned.folders} folders and ${scanned.files} files carrying an ACL.`);
  console.log(`Affected ${affected.length} resource(s).\n`);

  if (affected.length === 0) {
    console.log('No conflicts. Every principal holds at most one entry per resource, so the');
    console.log('D1 unique index will accept the arrays as they stand.');
    return;
  }

  console.log('By kind:');
  for (const [kind, n] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(6)}  ${kind}`);
  }

  console.log('\nResolution rules, in order:');
  console.log('  1. expired entries contribute nothing');
  console.log('  2. a live denial wins over every allow');
  console.log('  3. otherwise the strongest live allow wins');
  console.log('  4. if nothing is live, the principal gets no entry\n');

  for (const resource of affected.slice(0, 50)) {
    console.log(`${resource.resourceType} ${resource.resourceId}  ${resource.name}`);
    for (const conflict of resource.conflicts) {
      const kept = conflict.resolved
        ? `${conflict.resolved.deny ? 'DENY' : conflict.resolved.accessLevel}`
        : 'nothing (all expired)';
      console.log(
        `    ${conflict.principalType}:${conflict.principalId}  ` +
          `${conflict.entryCount} entries [${conflict.kinds.join(', ')}]  ->  keep ${kept}` +
          `, discard ${conflict.discarded.length}`,
      );
    }
  }
  if (affected.length > 50) {
    console.log(`\n... and ${affected.length - 50} more. Use --json for the full list.`);
  }

  console.log('\nNothing was written. Re-run with --json to capture this for the migration');
  console.log('audit report before Phase 5 runs.');
}

async function main(): Promise<void> {
  const summary = await scan();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    print(summary);
  }
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
