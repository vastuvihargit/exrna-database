/**
 * Hierarchy mutations that span more than one repository, committed as one D1 batch.
 *
 * ── The window this closes ──────────────────────────────────────────────────────────────
 *
 * A folder move changes two things that must agree: where the folders are, and where the files
 * inside them think they are. Until now the service did:
 *
 *     folderRepository.moveSubtree(...)     // batch 1 commits
 *     fileRepository.reparentSubtree(...)   // batch 2 commits
 *
 * On MongoDB both ran inside one session, so a failure rolled the pair back. On D1 there is no
 * interactive transaction and `withTransaction` opens a *Mongo* session, which does nothing for
 * D1 statements — so a crash, a timeout, or a thrown error between the two left the folders
 * moved and every file in the subtree still carrying its old ancestor chain.
 *
 * That state is not self-announcing. Reads by id keep working; what breaks is anything that
 * goes through the closure table — subtree search, "everything under this project", and the
 * inheritance predicate, which decides *visibility*. A file whose ancestors still name the old
 * parent inherits the old parent's ACL. So the failure mode is not a wrong breadcrumb, it is a
 * file that stays visible to the people who could see its old location.
 *
 * ── The shape ───────────────────────────────────────────────────────────────────────────
 *
 *     read everything          → the moved folder, the destination, the subtree, the chains
 *     compute the new shape    → in memory, for folders *and* files
 *     build every statement    → from both repositories' builders, nothing executed
 *     one db.batch()           → all commit, or none do
 *     verify + retry on no-op  → the guard failed, somebody else got there first
 *
 * Nothing here executes a statement of its own, and nothing reads hierarchy state that the
 * batch itself rewrites. The file half's chains are computed from the folder half's *plan*
 * rather than from `folder_ancestors`, because at planning time the folder statements have not
 * run — that inversion is the whole reason this module exists.
 *
 * ── What this module is not ─────────────────────────────────────────────────────────────
 *
 * **Not an authorization boundary.** The service authorises the source and the destination
 * before it calls this, exactly as before. What is re-checked here is *structural* — circular
 * moves, cross-tenant moves, a destination that has since been deleted — because those corrupt
 * the closure table in ways no later read reports as an error.
 *
 * **Not a general transaction manager.** It composes one operation. Adding a second should mean
 * a second named function with its own plan type, not a generic "run these statements" helper
 * that callers assemble ad hoc — the value here is that the plan is typed and complete before
 * anything runs.
 */
import type { BatchItem } from 'drizzle-orm/batch';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withBatch, type Database } from './d1';
import { getD1 } from './d1-context';
import { files, folderAncestors } from './schema/drive';
import { AppError, ConflictError, ValidationError } from '@/server/errors/app-error';
import { getLogger } from '@/server/logging/logger';
import { isD1 } from '@/server/repositories/data-source';
import {
  assertMoveIsStructurallyLegal,
  buildChildFolderCountStatement,
  buildFolderMoveCommitStatement,
  buildFolderMoveStatements,
  buildFolderSubtreeDeletedStatements,
  buildFolderSubtreeStatusStatements,
  countFolderSubtreeStatus,
  countFolderSubtreeSweep,
  moveDidApply,
  moveGuard,
  planFolderMove,
  MOVE_CONTENTION_MESSAGE,
} from '@/server/repositories/folder.repository.d1';
import {
  buildFileReparentStatements,
  buildFileSubtreeDeletedStatements,
  buildFileSubtreeStatusStatements,
  countFileSubtreeStatus,
  countFileSubtreeSweep,
  type FolderChain,
} from '@/server/repositories/file.repository.d1';
import type { MoveSubtreeInput } from '@/server/repositories/folder.repository.contract';

/** How many times a contended move re-plans before giving up. Matches the folder repository. */
const MOVE_ATTEMPTS = 3;

function nowIso(): string {
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ safety limits */

/**
 * Ceilings on one atomic move.
 *
 * ── Where the numbers come from ─────────────────────────────────────────────────────────
 *
 * The binding ceiling is the one hard constraint the project already reasons about:
 * `visibility.d1.ts` records that SQLite's default `SQLITE_MAX_VARIABLE_NUMBER` is 999 and that
 * D1 rejects statements carrying more, and it picked `MAX_ACTOR_PRINCIPALS = 200` to stay well
 * inside that. The same reasoning applies here, because the file statements bind one parameter
 * per folder in the subtree.
 *
 * `MAX_MOVE_FOLDERS` is therefore 200, matching that precedent rather than inventing a new one.
 * `MAX_COPY_FOLDERS` in `folder.service.ts` (2000) is the precedent for the *shape* of the
 * refusal — a controlled `ValidationError` naming the limit — but not for the size, because a
 * copy is not bound to a single batch the way this is.
 *
 * ── Why files do not appear here as a batch constraint ──────────────────────────────────
 *
 * They used to. The previous file rebuild emitted one statement per (file, ancestor) pair, so
 * the batch grew with the file count and a folder holding ten thousand files could not be moved
 * atomically at all. The rebuild is now per *folder* — `INSERT ... SELECT` over
 * `files.folder_id` — so the statement count is `folders × depth` and the file count does not
 * enter into it.
 *
 * `MAX_MOVE_FILES` remains as a blunt guard on the *work* one statement does rather than on the
 * number of statements: a single `UPDATE` touching a million rows is still a query that can
 * exceed D1's execution time limit, and failing before the move with a clear message beats
 * timing out halfway. It is deliberately generous.
 */
export const MAX_BATCH_STATEMENTS = 900;
export const MAX_MOVE_FOLDERS = 200;
export const MAX_MOVE_FILES = 50_000;
export const MAX_MOVE_ANCESTOR_ROWS = 20_000;

/**
 * Raised when a subtree is too large to move in one atomic batch.
 *
 * A `ValidationError`, not an internal error: the operator has asked for something the system
 * declines to do, and the message says so. **Nothing has been written when this is thrown** —
 * the check runs against the plan, before the batch opens.
 *
 * Splitting the move across several committed batches would be the obvious escape and is
 * exactly wrong: it would reintroduce the window this module exists to close, with a larger
 * blast radius. A very large tree needs an asynchronous migration with its own progress and
 * resumption model, which is a separate piece of work.
 */
export class SubtreeTooLargeError extends ValidationError {
  constructor(
    /**
     * Whatever was measured before the refusal. `files`, `statements` and `ancestorRows` are
     * absent when the folder ceiling was hit first, because the reads that would have produced
     * them are the reads too large a subtree cannot survive.
     */
    readonly counts: {
      folders: number;
      files?: number;
      statements?: number;
      ancestorRows?: number;
    },
  ) {
    super(
      'This folder contains too much to move in one operation. ' +
        'An administrator can move its subfolders individually, or migrate it in the background.',
      counts,
    );
  }
}

/**
 * Every folder operation that changes folder *and* file rows together.
 *
 * Named rather than boolean so the refusal, the log line and the audit trail all say which
 * operation was declined. Adding one here without giving it an atomic implementation is a type
 * error at the switch in the service, which is the point.
 */
export type HierarchyOperation = 'move' | 'trash' | 'restore' | 'archive' | 'unarchive';

/** How each operation reads in a sentence addressed to the person who attempted it. */
const OPERATION_VERB: Record<HierarchyOperation, string> = {
  move: 'moved',
  trash: 'deleted',
  restore: 'restored',
  archive: 'archived',
  unarchive: 'unarchived',
};

/**
 * Raised when folders and files are on different databases and a cascading mutation is attempted.
 *
 * **Fails closed, deliberately.** No transaction spans MongoDB and D1, so a cascading folder
 * operation under a split configuration cannot be made atomic by any means available here — it
 * would commit the folder half to one database and then attempt the file half against another,
 * which is the original bug with a wider gap. Reads under a split configuration are unaffected;
 * only cascading *mutations* are refused.
 */
export class SplitDataSourceHierarchyError extends AppError {
  constructor(
    readonly operation: HierarchyOperation,
    folders: string,
    files: string,
  ) {
    super(
      'CONFLICT',
      `Folders cannot be ${OPERATION_VERB[operation]} while the system is switching databases. ` +
        'Please try again later, or contact an administrator.',
      409,
      {
        details: {
          operation,
          folders,
          files,
          reason:
            `DATA_SOURCE_FOLDERS=${folders} and DATA_SOURCE_FILES=${files}. A folder ${operation} ` +
            'changes folder and file rows together and no transaction spans two databases, so ' +
            'the operation is refused rather than committed half-way. Set both flags to the ' +
            'same value.',
        },
      },
    );
  }
}

/**
 * Which engine a cascading hierarchy mutation should use, or a refusal.
 *
 * The single decision point for every operation in `HierarchyOperation`, on both engines. The
 * two flags moving independently is a deliberate property of the migration — one module at a
 * time — but these are the operations that span both modules, so they are the ones that cannot
 * tolerate the flags disagreeing.
 */
export function hierarchyMutationEngine(operation: HierarchyOperation): 'd1' | 'mongo' {
  const foldersOnD1 = isD1('folders');
  const filesOnD1 = isD1('files');

  if (foldersOnD1 !== filesOnD1) {
    const folders = foldersOnD1 ? 'd1' : 'mongo';
    const files = filesOnD1 ? 'd1' : 'mongo';
    getLogger().error(
      { module: 'hierarchy', operation, folders, files },
      `Refusing a folder ${operation} because folders and files are on different databases`,
    );
    throw new SplitDataSourceHierarchyError(operation, folders, files);
  }

  return foldersOnD1 ? 'd1' : 'mongo';
}

/* ------------------------------------------------------------------ the plan */

export interface HierarchyMovePlan {
  /** Every folder in the subtree, with the ancestor chain it will have after the move. */
  folderChains: FolderChain[];
  /** Only the folders that actually contain files — what the file statements iterate. */
  fileFolderChains: FolderChain[];
  counts: { folders: number; files: number; statements: number; ancestorRows: number };
}

/**
 * Computes the whole new shape in memory, from state read *before* anything is written.
 *
 * The moved folder's descendants keep their relative structure — a move re-roots a subtree, it
 * does not rearrange it — so each descendant's new chain is the destination's chain, then the
 * moved folder, then whatever already sat between the moved folder and that descendant. That
 * suffix is read from the current `folder_ancestors`, which is correct precisely because it has
 * *not* been rewritten yet.
 */
async function planHierarchyMove(
  db: Database,
  input: MoveSubtreeInput,
): Promise<HierarchyMovePlan> {
  const newPrefix = [...input.newPathAncestors, input.folderId];

  // Every descendant folder, with its current chain, in one read.
  const descendantRows = await db
    .select({
      folderId: folderAncestors.folderId,
      ancestorId: folderAncestors.ancestorId,
      depth: folderAncestors.depth,
    })
    .from(folderAncestors)
    .where(
      inArray(
        folderAncestors.folderId,
        db
          .select({ id: folderAncestors.folderId })
          .from(folderAncestors)
          .where(eq(folderAncestors.ancestorId, input.folderId)),
      ),
    )
    .orderBy(asc(folderAncestors.folderId), asc(folderAncestors.depth));

  const currentChains = new Map<string, string[]>();
  for (const row of descendantRows) {
    const chain = currentChains.get(row.folderId);
    if (chain) chain.push(row.ancestorId);
    else currentChains.set(row.folderId, [row.ancestorId]);
  }

  const folderChains: FolderChain[] = [
    { folderId: input.folderId, chain: newPrefix },
    ...[...currentChains.entries()].map(([folderId, chain]) => {
      const cut = chain.indexOf(input.folderId);
      const below = cut === -1 ? [] : chain.slice(cut + 1);
      return { folderId, chain: [...newPrefix, ...below, folderId] };
    }),
  ];

  const subtreeFolderIds = folderChains.map((entry) => entry.folderId);

  /**
   * The folder ceiling is enforced **here**, before the file reads, not with the other limits
   * at the end.
   *
   * Those reads bind one parameter per folder in the subtree. Past roughly a thousand
   * parameters SQLite refuses the statement outright, so on a genuinely oversized subtree the
   * planner would die with "Failed query: select count(*)" — an internal error naming a SQL
   * statement — instead of the controlled refusal that tells the operator what is actually
   * wrong. Found by the test that fabricates an oversized subtree, which asserted the error
   * type rather than merely that it threw.
   */
  if (subtreeFolderIds.length > MAX_MOVE_FOLDERS) {
    getLogger().warn(
      { folders: subtreeFolderIds.length, limit: MAX_MOVE_FOLDERS },
      'Refusing a folder move: the subtree exceeds the folder limit for one atomic batch',
    );
    throw new SubtreeTooLargeError({ folders: subtreeFolderIds.length });
  }

  // Which of those folders hold live files, and how many files in total. Both bounded reads;
  // neither returns the files themselves.
  const [foldersWithFiles, fileCount] = await Promise.all([
    db
      .selectDistinct({ folderId: files.folderId })
      .from(files)
      .where(and(inArray(files.folderId, subtreeFolderIds), isNull(files.deletedAt))),
    db
      .select({ value: sql<number>`count(*)` })
      .from(files)
      .where(and(inArray(files.folderId, subtreeFolderIds), isNull(files.deletedAt))),
  ]);

  const withFiles = new Set(foldersWithFiles.map((row) => row.folderId));
  const fileFolderChains = folderChains.filter((entry) => withFiles.has(entry.folderId));

  const files_ = fileCount[0]?.value ?? 0;
  const ancestorRows = fileFolderChains.reduce((sum, entry) => sum + entry.chain.length, 0);

  // 6 + 2×newDepth for the folder half, 2 + Σ chain lengths for the file half, 2 child counts,
  // 1 commit. Counted rather than estimated, because the refusal has to be exact.
  const statements =
    6 + 2 * input.newPathAncestors.length + (fileFolderChains.length ? 2 + ancestorRows : 0) + 3;

  return {
    folderChains,
    fileFolderChains,
    counts: { folders: folderChains.length, files: files_, statements, ancestorRows },
  };
}

function assertWithinLimits(plan: HierarchyMovePlan): void {
  const { counts } = plan;
  if (
    counts.folders > MAX_MOVE_FOLDERS ||
    counts.files > MAX_MOVE_FILES ||
    counts.statements > MAX_BATCH_STATEMENTS ||
    counts.ancestorRows > MAX_MOVE_ANCESTOR_ROWS
  ) {
    getLogger().warn(
      {
        ...counts,
        limits: {
          folders: MAX_MOVE_FOLDERS,
          files: MAX_MOVE_FILES,
          statements: MAX_BATCH_STATEMENTS,
          ancestorRows: MAX_MOVE_ANCESTOR_ROWS,
        },
      },
      'Refusing a folder move that exceeds the atomic batch limits',
    );
    throw new SubtreeTooLargeError(counts);
  }
}

/* ------------------------------------------------------------------ the operation */

export interface HierarchyMoveInput extends MoveSubtreeInput {
  /** The folder the subtree is leaving, so its child count can be decremented. */
  previousParentId: string | null;
}

/**
 * Moves a folder subtree and every file inside it, as one D1 batch.
 *
 * The statement order is load-bearing:
 *
 *   1. folder rows and `folder_ancestors`      — guarded
 *   2. file rows and `file_folder_ancestors`   — guarded, same token
 *   3. the two child-count adjustments
 *   4. the moved folder's own row              — **invalidates the guard, so it goes last**
 *
 * Everything in 1–3 carries "the moved folder's `updated_at` is still what I planned against".
 * Step 4 is the only statement that changes it. So either the whole batch applies to the state
 * it was computed from, or a concurrent writer got there first and *every* guarded statement
 * matches nothing — which the caller detects as a no-op and retries. There is no arrangement in
 * which the folders move and the files do not.
 */
export async function moveFolderSubtreeWithFiles(input: HierarchyMoveInput): Promise<void> {
  const db = await getD1();
  await assertMoveIsStructurallyLegal(db, input);

  for (let attempt = 0; attempt < MOVE_ATTEMPTS; attempt += 1) {
    const plan = await planHierarchyMove(db, input);
    assertWithinLimits(plan);

    const movePlan = await planFolderMove(db, input.folderId, input.newPathAncestors);
    const guard = moveGuard(input.folderId, movePlan.stamp);

    const statements: BatchItem<'sqlite'>[] = [
      ...buildFolderMoveStatements(db, input, movePlan),
      ...buildFileReparentStatements(db, {
        folderId: input.folderId,
        newPathAncestorsForFolder: input.newPathAncestors,
        driveType: input.driveType,
        departmentId: input.departmentId,
        projectId: input.projectId,
        folderChains: plan.fileFolderChains,
        now: movePlan.now,
        guard,
      }),
    ];

    if (input.previousParentId) {
      statements.push(buildChildFolderCountStatement(db, input.previousParentId, -1));
    }
    statements.push(buildChildFolderCountStatement(db, input.newParentId, 1));

    // Last. Nothing guarded may follow it.
    statements.push(buildFolderMoveCommitStatement(db, input, movePlan));

    await withBatch(db, statements);

    if (await moveDidApply(db, input, movePlan)) return;
  }

  throw new ConflictError(MOVE_CONTENTION_MESSAGE);
}

/* ------------------------------------------------------------------ lifecycle */

/**
 * What a lifecycle sweep changed, counted before it ran.
 *
 * Both numbers reach an audit entry, so both are read with the sweep's own predicate rather
 * than from `meta.changes` — which counts the FTS trigger's writes and the side tables' cascades
 * as well, and reported 6 for one purged file.
 */
export interface LifecycleCounts {
  folders: number;
  files: number;
}

export interface SubtreeSweepInput {
  folderId: string;
  userId: string;
  /** The parent whose child count moves with the sweep, if the folder has one. */
  parentFolderId: string | null;
}

/**
 * Trashes or restores a folder subtree and every file in it, as one D1 batch.
 *
 * ── Why this needs no `updated_at` guard ────────────────────────────────────────────────
 *
 * The move does, because its statements carry values a prior read supplied — a depth shift that
 * is wrong if the folder moved in between, and applying half a shift to a closure table produces
 * a quietly malformed tree. Nothing here is like that. Every statement is set-wise and its
 * predicate is evaluated by SQLite at execution time, so the batch acts on whatever the subtree
 * actually is when it runs. The only values read in advance are the two *counts*, and a count
 * that raced is a slightly stale audit number, not a corrupt hierarchy.
 *
 * The order is folders, then files, then the child-count adjustment. Nothing depends on it —
 * no statement here reads a table another one writes — but it matches the order the Mongo
 * transaction uses, so the two engines read the same way.
 */
async function sweepFolderSubtreeWithFiles(
  input: SubtreeSweepInput,
  deleted: boolean,
): Promise<LifecycleCounts> {
  const db = await getD1();
  const now = nowIso();

  // Before the writes, with the same predicates the writes use.
  const [folderCount, fileCount] = await Promise.all([
    countFolderSubtreeSweep(db, { folderId: input.folderId, deleted }),
    countFileSubtreeSweep(db, { folderId: input.folderId, deleted }),
  ]);

  const statements: BatchItem<'sqlite'>[] = [
    ...buildFolderSubtreeDeletedStatements(db, {
      folderId: input.folderId,
      deleted,
      userId: input.userId,
      now,
    }),
    ...buildFileSubtreeDeletedStatements(db, {
      folderId: input.folderId,
      deleted,
      userId: input.userId,
      now,
    }),
  ];

  // Trashing removes the folder from its parent's child count; restoring puts it back.
  if (input.parentFolderId) {
    statements.push(buildChildFolderCountStatement(db, input.parentFolderId, deleted ? -1 : 1));
  }

  await withBatch(db, statements);

  return { folders: folderCount, files: fileCount };
}

/** Moves a folder subtree and every live file in it to the trash, atomically. */
export function trashFolderSubtreeWithFiles(input: SubtreeSweepInput): Promise<LifecycleCounts> {
  return sweepFolderSubtreeWithFiles(input, true);
}

/**
 * Restores a folder subtree and exactly the files that this trash operation swept in, atomically.
 *
 * A file trashed on its own *before* the folder was trashed carries a different
 * `trashed_with_folder_id` — usually null — so the restore predicate does not match it and it
 * stays in the trash. That rule lives in the builders, shared with the standalone path.
 */
export function restoreFolderSubtreeWithFiles(input: SubtreeSweepInput): Promise<LifecycleCounts> {
  return sweepFolderSubtreeWithFiles(input, false);
}

/**
 * Archives or unarchives a folder subtree and every live file in it, as one D1 batch.
 *
 * Trashed files keep `status = 'trashed'` throughout — archive and trash are separate
 * lifecycles, and the file half's `live()` predicate is the line between them. No child-count
 * adjustment: archiving does not remove a folder from its parent.
 */
export async function setFolderSubtreeStatusWithFiles(input: {
  folderId: string;
  status: 'active' | 'archived';
  userId: string;
}): Promise<LifecycleCounts> {
  const db = await getD1();
  const now = nowIso();

  const [folderCount, fileCount] = await Promise.all([
    countFolderSubtreeStatus(db, input.folderId),
    countFileSubtreeStatus(db, input.folderId),
  ]);

  await withBatch(db, [
    ...buildFolderSubtreeStatusStatements(db, { ...input, now }),
    ...buildFileSubtreeStatusStatements(db, { folderId: input.folderId, status: input.status, now }),
  ]);

  return { folders: folderCount, files: fileCount };
}

/**
 * Test seam: the plan without the execution.
 *
 * Exported so a test can assert the statement *count* of a move — the number the limits are
 * expressed in — without needing a subtree large enough to trip them, and so the counting
 * itself is covered rather than trusted.
 */
export async function planHierarchyMoveForTesting(
  input: MoveSubtreeInput,
): Promise<HierarchyMovePlan> {
  return planHierarchyMove(await getD1(), input);
}

