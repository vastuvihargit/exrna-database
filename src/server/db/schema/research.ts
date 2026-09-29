/**
 * Projects and experiments — the research context a file is traced back to.
 */
import { index, sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { CONFIDENTIALITY_LEVELS } from '@/server/domain/permissions';
import { PROJECT_STATUSES } from '@/server/db/models/project.model';
import {
  EXPERIMENT_OUTCOMES,
  EXPERIMENT_STATUSES,
} from '@/server/db/models/experiment.model';
import { enumText, softDeleteColumns, timestampColumns } from './_shared';
import { departments, organizations, users } from './identity';

/* ------------------------------------------------------------------ projects */

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    departmentId: text('department_id')
      .notNull()
      .references(() => departments.id),

    name: text('name').notNull(),
    /** Human-facing short identifier used in filenames and search, e.g. `EXR-2026-014`. */
    code: text('code').notNull(),
    description: text('description').notNull().default(''),

    leadUserId: text('lead_user_id').references(() => users.id),
    /** Back-filled after folders load — see the note on `departments.rootFolderId`. */
    rootFolderId: text('root_folder_id'),

    status: enumText('status', PROJECT_STATUSES).notNull().default('active'),
    confidentiality: enumText('confidentiality', CONFIDENTIALITY_LEVELS)
      .notNull()
      .default('internal'),

    startDate: text('start_date'),
    targetEndDate: text('target_end_date'),
    completedAt: text('completed_at'),

    storageUsedBytes: integer('storage_used_bytes').notNull().default(0),
    fileCount: integer('file_count').notNull().default(0),

    createdBy: text('created_by').references(() => users.id),
    ...timestampColumns,
    ...softDeleteColumns,
  },
  (table) => [
    uniqueIndex('ux_projects_org_code').on(table.organizationId, table.code),
    index('ix_projects_org_dept_status').on(
      table.organizationId,
      table.departmentId,
      table.status,
    ),
  ],
);

/* ------------------------------------------------------------------ project_members */

/**
 * The single source of truth for project membership.
 *
 * MongoDB stored this twice — `projects.memberUserIds[]` and `users.projectIds[]` — and kept
 * them in step from the service layer. The Phase 5 migration loads the **union** of both
 * arrays and reports any row present in one and not the other, because a disagreement there
 * is a real access-control defect that the duplication was hiding.
 */
export const projectMembers = sqliteTable(
  'project_members',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addedAt: text('added_at').notNull(),
    addedBy: text('added_by').references(() => users.id),
  },
  (table) => [
    uniqueIndex('ux_project_members').on(table.projectId, table.userId),
    // "Which projects am I in?" — read on every visibility check, so it must be indexed
    // from the user side as well as the project side.
    index('ix_project_members_user').on(table.userId),
  ],
);

/* ------------------------------------------------------------------ experiments */

export const experiments = sqliteTable(
  'experiments',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    /** Denormalized from the project so department-scoped queries need one lookup. */
    departmentId: text('department_id').references(() => departments.id),

    code: text('code').notNull(),
    title: text('title').notNull(),
    objective: text('objective').notNull().default(''),

    status: enumText('status', EXPERIMENT_STATUSES).notNull().default('planned'),
    outcome: enumText('outcome', EXPERIMENT_OUTCOMES).notNull().default('pending'),
    outcomeSummary: text('outcome_summary').notNull().default(''),

    leadUserId: text('lead_user_id').references(() => users.id),

    /** References, not foreign keys — deliberately, so this does not become a LIMS. */
    protocolRef: text('protocol_ref').notNull().default(''),
    instrumentRef: text('instrument_ref').notNull().default(''),
    organism: text('organism').notNull().default(''),

    startedOn: text('started_on'),
    completedOn: text('completed_on'),
    /** Optional home folder, normally `04_Experiments/<code>`. Back-filled after folders. */
    folderId: text('folder_id'),

    confidentiality: enumText('confidentiality', CONFIDENTIALITY_LEVELS)
      .notNull()
      .default('internal'),
    fileCount: integer('file_count').notNull().default(0),

    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    updatedBy: text('updated_by').references(() => users.id),
    ...timestampColumns,
    ...softDeleteColumns,
  },
  (table) => [
    /**
     * Unique per organization, not per project — an experiment code is printed on notebooks
     * and sample tubes, and two experiments answering to `EXP-014` is exactly the ambiguity
     * this platform exists to end.
     */
    uniqueIndex('ux_experiments_org_code').on(table.organizationId, table.code),
    index('ix_experiments_project').on(table.projectId, table.deletedAt, table.code),
    index('ix_experiments_org_dept_status').on(
      table.organizationId,
      table.departmentId,
      table.status,
    ),
    index('ix_experiments_lead').on(table.leadUserId),
  ],
);

export const experimentCollaborators = sqliteTable(
  'experiment_collaborators',
  {
    experimentId: text('experiment_id')
      .notNull()
      .references(() => experiments.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('ux_experiment_collaborators').on(table.experimentId, table.userId),
    index('ix_experiment_collaborators_user').on(table.userId),
  ],
);

/**
 * `experiments.sampleIds[]` — the identifiers printed on the tubes.
 *
 * A child table rather than JSON because Mongo indexed `{ organizationId, sampleIds }`:
 * "which experiment did sample S-4471 come from?" is a question researchers actually ask,
 * and it has to be an index lookup rather than a scan.
 */
export const experimentSamples = sqliteTable(
  'experiment_samples',
  {
    experimentId: text('experiment_id')
      .notNull()
      .references(() => experiments.id, { onDelete: 'cascade' }),
    sampleId: text('sample_id').notNull(),
  },
  (table) => [
    uniqueIndex('ux_experiment_samples').on(table.experimentId, table.sampleId),
    index('ix_experiment_samples_sample').on(table.sampleId),
  ],
);
