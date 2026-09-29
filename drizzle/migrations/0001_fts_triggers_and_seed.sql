-- ---------------------------------------------------------------------------------------
-- Phase 2, migration 0001 — what the schema definition cannot express.
--
-- Three things live here rather than in `src/server/db/schema/`, because drizzle-kit has no
-- vocabulary for any of them:
--
--   1. FTS5 virtual tables, replacing the MongoDB `$text` indexes
--   2. RAISE(ABORT) triggers, replacing the Mongoose immutability pre-hooks
--   3. the permission catalogue seed
--
-- Everything here is idempotent (`IF NOT EXISTS`, `INSERT OR IGNORE`) so re-applying the
-- migration against a partially-migrated database is safe.
-- ---------------------------------------------------------------------------------------


-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 1. Full-text search
--
-- MongoDB gave each collection one weighted `$text` index and sorted by `$meta: 'textScore'`.
-- SQLite's equivalent is FTS5 with `bm25()`, whose per-column weights are supplied at query
-- time rather than at index time. The weights that reproduce the Mongo ranking are recorded
-- next to each table and are applied by the Phase 3 search repository.
--
-- ⚠️ CORRECTED (Phase 3, module 3). `bm25()` takes one weight per column **including the
-- UNINDEXED one**. This comment previously read:
--
--     ORDER BY bm25(files_fts, 10.0, 6.0, 5.0, 1.0)     -- WRONG: shifted by one
--
-- which assigns 10.0 to `file_id` — a column that never matches — and leaves `description`
-- on the 1.0 default. The intended weighting is entirely lost. Demonstrated on a real FTS5
-- table: with the leading placeholder omitted, two documents matching in differently-weighted
-- columns score *identically*.
--
-- The correct form keeps a placeholder for the UNINDEXED column:
--
--     ORDER BY bm25(files_fts, 0.0, 10.0, 6.0, 5.0, 1.0)
--     ORDER BY bm25(experiments_fts, 0.0, 10.0, 8.0, 6.0, 1.0)
--
-- `experiment.repository.d1.ts` uses the corrected form and has a test that fails if the
-- weights shift. No production code used the files_fts form — the file repository arrives in
-- module 4 — so nothing was mis-ranked in a running system.
--
-- These are **standalone** FTS5 tables, not `content=` external-content tables. External
-- content would tie each FTS row to exactly one base table, and the searchable text for a
-- file is spread across three (`files`, `file_metadata`, `resource_tags`). A standalone table
-- can hold all of it in one row.
--
-- `file_id` / `folder_id` / `experiment_id` are UNINDEXED: they are the join key back to the
-- base table and must never themselves be matched as search terms — otherwise pasting an id
-- into the search box would return the record regardless of whether the searcher may see it.
-- ═════════════════════════════════════════════════════════════════════════════════════════

-- Weights: display_name 10, original_filename 6, tags 5 / metadata 5, description 1.
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
  file_id UNINDEXED,
  display_name,
  original_filename,
  keywords,          -- tags + metadata.sampleId + metadata.experimentCode, space-joined
  description,       -- metadata.description
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE IF NOT EXISTS folders_fts USING fts5(
  folder_id UNINDEXED,
  name,
  description,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Weights: code 10, title 8, samples 6, tags 4, objective 1.
CREATE VIRTUAL TABLE IF NOT EXISTS experiments_fts USING fts5(
  experiment_id UNINDEXED,
  code,
  title,
  samples,
  objective,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- ── Index maintenance ───────────────────────────────────────────────────────────────────
--
-- Triggers keep the *base-table* columns in step automatically, so an insert, rename or
-- trash is reflected in search immediately and without the application remembering to do it.
--
-- The columns sourced from `file_metadata` and `resource_tags` are deliberately **not**
-- trigger-maintained. A trigger on those tables would have to re-aggregate every metadata row
-- and every tag for the file on each single-row change, which turns a tag edit into a
-- fan-out. They are written by an explicit re-index statement that the Phase 3 repository
-- calls after a metadata or tag write, and that the Phase 4 `SYNC_QUEUE` search-indexing
-- consumer calls when it rebuilds. Both use the same statement, so there is one code path.
--
-- A trashed row is removed from the index rather than filtered at query time. Search must
-- never return a trashed file, and an index that cannot produce one is a stronger guarantee
-- than a WHERE clause somebody has to remember to add.

CREATE TRIGGER IF NOT EXISTS trg_files_fts_insert
AFTER INSERT ON files
WHEN new.deleted_at IS NULL
BEGIN
  INSERT INTO files_fts (file_id, display_name, original_filename, keywords, description)
  VALUES (new.id, new.display_name, new.original_filename, '', '');
END;

CREATE TRIGGER IF NOT EXISTS trg_files_fts_delete
AFTER DELETE ON files
BEGIN
  DELETE FROM files_fts WHERE file_id = old.id;
END;

-- One trigger for rename, trash and restore. `UPDATE OF` would need three separate triggers
-- and would miss a statement that changed two of the columns at once.
CREATE TRIGGER IF NOT EXISTS trg_files_fts_update
AFTER UPDATE ON files
BEGIN
  DELETE FROM files_fts WHERE file_id = old.id;
  INSERT INTO files_fts (file_id, display_name, original_filename, keywords, description)
  SELECT
    new.id,
    new.display_name,
    new.original_filename,
    COALESCE((SELECT group_concat(tag, ' ') FROM resource_tags
               WHERE resource_type = 'file' AND resource_id = new.id), '')
      || ' ' ||
    COALESCE((SELECT group_concat(value, ' ') FROM file_metadata
               WHERE file_id = new.id AND key IN ('sampleId', 'experimentCode')), ''),
    COALESCE((SELECT value FROM file_metadata
               WHERE file_id = new.id AND key = 'description'), '')
  WHERE new.deleted_at IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_folders_fts_insert
AFTER INSERT ON folders
WHEN new.deleted_at IS NULL
BEGIN
  INSERT INTO folders_fts (folder_id, name, description)
  VALUES (new.id, new.name, new.description);
END;

CREATE TRIGGER IF NOT EXISTS trg_folders_fts_delete
AFTER DELETE ON folders
BEGIN
  DELETE FROM folders_fts WHERE folder_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_folders_fts_update
AFTER UPDATE ON folders
BEGIN
  DELETE FROM folders_fts WHERE folder_id = old.id;
  INSERT INTO folders_fts (folder_id, name, description)
  SELECT new.id, new.name, new.description WHERE new.deleted_at IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_experiments_fts_insert
AFTER INSERT ON experiments
WHEN new.deleted_at IS NULL
BEGIN
  INSERT INTO experiments_fts (experiment_id, code, title, samples, objective)
  VALUES (new.id, new.code, new.title, '', new.objective);
END;

CREATE TRIGGER IF NOT EXISTS trg_experiments_fts_delete
AFTER DELETE ON experiments
BEGIN
  DELETE FROM experiments_fts WHERE experiment_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_experiments_fts_update
AFTER UPDATE ON experiments
BEGIN
  DELETE FROM experiments_fts WHERE experiment_id = old.id;
  INSERT INTO experiments_fts (experiment_id, code, title, samples, objective)
  SELECT
    new.id,
    new.code,
    new.title,
    COALESCE((SELECT group_concat(sample_id, ' ') FROM experiment_samples
               WHERE experiment_id = new.id), ''),
    new.objective
  WHERE new.deleted_at IS NULL;
END;


-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 2. Immutability
--
-- The audit log and the stock ledger are append-only. MongoDB enforced this in three layers:
-- a repository exposing only append and query, pre-hooks rejecting every update and delete,
-- and a scoped database user in production.
--
-- Layers 1 and 3 carry over unchanged. Layer 2 is these triggers. Without them, immutability
-- would be a property of the code that happens to be calling rather than of the data — and a
-- future service that tries to "fix" a row would quietly rewrite history instead of failing.
--
-- Note there is no equivalent trigger on `approvals`, deliberately. MongoDB enforced that
-- table's append-only nature by service discipline rather than by a hook (decisions were an
-- embedded array inside an updatable document), and adding a hard constraint here would be
-- tightening a rule the application has never been tested against.
-- ═════════════════════════════════════════════════════════════════════════════════════════

CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_update
BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'Audit logs are append-only and cannot be modified or deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_delete
BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'Audit logs are append-only and cannot be modified or deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_stock_transactions_no_update
BEFORE UPDATE ON stock_transactions
BEGIN
  SELECT RAISE(ABORT, 'Stock history is append-only and cannot be modified or deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_stock_transactions_no_delete
BEFORE DELETE ON stock_transactions
BEGIN
  SELECT RAISE(ABORT, 'Stock history is append-only and cannot be modified or deleted');
END;


-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 3. Permission catalogue
--
-- One row per value in `src/server/domain/permissions.ts`, which stays the source of truth.
-- The table exists so `role_permissions.permission_key` can carry a foreign key: a typo'd
-- permission name then fails at insert instead of silently granting nothing.
--
-- `INSERT OR IGNORE` so re-applying is a no-op. A test asserts this list and the TypeScript
-- constant have not drifted apart.
-- ═════════════════════════════════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO permissions (key, description) VALUES
  ('file.view',              'See that a file exists and read its metadata'),
  ('file.preview',           'Open a file in the in-app preview'),
  ('file.upload',            'Upload a new file into a folder'),
  ('file.download',          'Download the original bytes of a file'),
  ('folder.create',          'Create a folder'),
  ('resource.rename',        'Rename a file or folder'),
  ('resource.move',          'Move a file or folder'),
  ('resource.copy',          'Copy a file or folder'),
  ('comment.create',         'Comment on a file'),
  ('share.internal',         'Share a file or folder with another employee'),
  ('metadata.edit',          'Edit research metadata on a file'),
  ('version.upload',         'Upload a new version of an existing file'),
  ('review.submit',          'Submit a file for review'),
  ('review.perform',         'Review a file and request changes'),
  ('review.approve',         'Approve or reject a version'),
  ('resource.archive',       'Archive a file or folder'),
  ('resource.restore',       'Restore a file or folder from the trash'),
  ('resource.delete',        'Move a file or folder to the trash'),
  ('resource.export',        'Export a set of files'),
  ('access.manage',          'Change permissions and inheritance on a resource'),
  ('user.manage',            'Create, update and deactivate employee accounts'),
  ('audit.view',             'Read the audit log'),
  ('inventory.view',         'See inventory items and stock levels'),
  ('inventory.item.manage',  'Create, update and deactivate inventory items'),
  ('inventory.stock.add',    'Receive stock into an item'),
  ('inventory.stock.issue',  'Issue stock from an item'),
  ('inventory.stock.adjust', 'Record a stock correction'),
  ('inventory.request',      'Request stock from a store');
