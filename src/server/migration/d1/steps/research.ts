/**
 * Projects and experiments, and the three arrays each of them carried.
 *
 * `projects.memberUserIds[]` becomes `project_members` and is the **only** copy of project
 * membership in D1 — `users.projectIds[]` is not reproduced. Where the two disagreed in MongoDB
 * the array on the project wins, because that is the one the sharing UI writes and the one the
 * visibility query in `visibility.d1.ts` joins.
 */
import { ExperimentModel, ProjectModel } from '@/server/db/models';
import {
  EXPERIMENT_OUTCOMES,
  EXPERIMENT_STATUSES,
} from '@/server/db/models/experiment.model';
import { PROJECT_STATUSES } from '@/server/db/models/project.model';
import { CONFIDENTIALITY_LEVELS } from '@/server/domain/permissions';
import { enumValue, iso, num, oid, oidList, requiredIso, requiredOid, str } from '../convert';
import { deleteWhere, insert, refreshExperimentFts, upsert } from '../sql';
import { modelStep } from '../step-helpers';
import type { MigrationStep, Statement, StepContext } from '../types';
import { timestamps } from './identity';

/** `projects.tags[]`, `experiments.tags[]` and `files.tags[]` share one table. */
function tagStatements(
  resourceType: 'file' | 'project' | 'experiment',
  resourceId: string,
  organizationId: string,
  raw: unknown,
): Statement[] {
  const statements: Statement[] = [
    deleteWhere('resource_tags', { resource_type: resourceType, resource_id: resourceId }),
  ];
  if (!Array.isArray(raw)) return statements;

  // `ux_resource_tags` is unique on (type, id, tag). MongoDB's array is not, and a duplicate
  // would abort the batch.
  for (const tag of new Set(raw.map((value) => str(value)).filter((value) => value.length > 0))) {
    statements.push(
      insert('resource_tags', {
        organization_id: organizationId,
        resource_type: resourceType,
        resource_id: resourceId,
        tag,
      }),
    );
  }
  return statements;
}

export const projectsStep: MigrationStep = modelStep({
  name: 'projects',
  description: 'Projects, their members and their tags',
  targets: ['projects', 'project_members', 'resource_tags'],
  requires: ['organizations', 'departments', 'users'],
  publishes: 'projects',
  model: ProjectModel as never,
  withDeleted: true,
  deltaField: 'updatedAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'projects._id');
    const organizationId = requiredOid(document.organizationId, 'projects.organizationId');
    const departmentId = requiredOid(document.departmentId, 'projects.departmentId');

    if (!context.known.get('organizations')?.has(organizationId)) {
      return { kind: 'skip', reason: `organization ${organizationId} was not migrated` };
    }
    // `projects.department_id` is NOT NULL and a foreign key. A project whose department is
    // gone cannot be represented, and inventing a department for it would put research files
    // under a boundary nobody chose.
    if (!context.known.get('departments')?.has(departmentId)) {
      return { kind: 'skip', reason: `department ${departmentId} was not migrated` };
    }

    const knownUsers = context.known.get('users');
    const leadUserId = oid(document.leadUserId);
    const createdBy = oid(document.createdBy);

    const statements: Statement[] = [
      upsert('projects', {
        id,
        organization_id: organizationId,
        department_id: departmentId,
        name: str(document.name),
        code: str(document.code),
        description: str(document.description),
        lead_user_id: leadUserId && knownUsers?.has(leadUserId) ? leadUserId : null,
        // Not a foreign key — see `schema/research.ts`. Written directly; folders load later.
        root_folder_id: oid(document.rootFolderId),
        status: enumValue(document.status, PROJECT_STATUSES, 'active'),
        confidentiality: enumValue(document.confidentiality, CONFIDENTIALITY_LEVELS, 'internal'),
        start_date: iso(document.startDate),
        target_end_date: iso(document.targetEndDate),
        completed_at: iso(document.completedAt),
        storage_used_bytes: num(document.storageUsedBytes),
        file_count: num(document.fileCount),
        created_by: createdBy && knownUsers?.has(createdBy) ? createdBy : null,
        ...timestamps(document),
        deleted_at: iso(document.deletedAt),
        deleted_by: oid(document.deletedBy),
      }),
      deleteWhere('project_members', { project_id: id }),
      ...tagStatements('project', id, organizationId, document.tags),
    ];

    const addedAt = requiredIso(document.createdAt, new Date(0).toISOString());
    for (const userId of new Set(oidList(document.memberUserIds))) {
      // A member who is no longer a user is dropped rather than skipping the project: losing a
      // membership row is recoverable from the sharing UI, losing the project is not.
      if (!knownUsers?.has(userId)) continue;
      statements.push(
        insert('project_members', {
          project_id: id,
          user_id: userId,
          // MongoDB never recorded when somebody joined a project. The project's own creation
          // time is the only defensible value: it is never later than the membership, and a
          // migration timestamp would claim every member joined at cutover.
          added_at: addedAt,
          added_by: null,
        }),
      );
    }

    return { kind: 'write', statements };
  },
});

export const experimentsStep: MigrationStep = modelStep({
  name: 'experiments',
  description: 'Experiments, collaborators, sample ids and tags',
  targets: [
    'experiments',
    'experiment_collaborators',
    'experiment_samples',
    'resource_tags',
    'experiments_fts',
  ],
  requires: ['projects', 'users'],
  publishes: 'experiments',
  model: ExperimentModel as never,
  withDeleted: true,
  deltaField: 'updatedAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'experiments._id');
    const organizationId = requiredOid(document.organizationId, 'experiments.organizationId');
    const projectId = requiredOid(document.projectId, 'experiments.projectId');
    const createdBy = requiredOid(document.createdBy, 'experiments.createdBy');

    if (!context.known.get('projects')?.has(projectId)) {
      return { kind: 'skip', reason: `project ${projectId} was not migrated` };
    }
    const knownUsers = context.known.get('users');
    if (!knownUsers?.has(createdBy)) {
      return { kind: 'skip', reason: `creator ${createdBy} was not migrated` };
    }

    const departmentId = oid(document.departmentId);
    const leadUserId = oid(document.leadUserId);
    const updatedBy = oid(document.updatedBy);
    const code = str(document.code);
    const title = str(document.title);
    const objective = str(document.objective);
    const samples = [
      ...new Set(
        (Array.isArray(document.sampleIds) ? document.sampleIds : [])
          .map((value) => str(value))
          .filter((value) => value.length > 0),
      ),
    ];

    const statements: Statement[] = [
      upsert('experiments', {
        id,
        organization_id: organizationId,
        project_id: projectId,
        department_id:
          departmentId && context.known.get('departments')?.has(departmentId) ? departmentId : null,
        code,
        title,
        objective,
        status: enumValue(document.status, EXPERIMENT_STATUSES, 'planned'),
        outcome: enumValue(document.outcome, EXPERIMENT_OUTCOMES, 'pending'),
        outcome_summary: str(document.outcomeSummary),
        lead_user_id: leadUserId && knownUsers.has(leadUserId) ? leadUserId : null,
        protocol_ref: str(document.protocolRef),
        instrument_ref: str(document.instrumentRef),
        organism: str(document.organism),
        started_on: iso(document.startedOn),
        completed_on: iso(document.completedOn),
        // Not a foreign key. Folders load after experiments, and the value is written now.
        folder_id: oid(document.folderId),
        confidentiality: enumValue(document.confidentiality, CONFIDENTIALITY_LEVELS, 'internal'),
        file_count: num(document.fileCount),
        created_by: createdBy,
        updated_by: updatedBy && knownUsers.has(updatedBy) ? updatedBy : null,
        ...timestamps(document),
        deleted_at: iso(document.deletedAt),
        deleted_by: oid(document.deletedBy),
      }),
      deleteWhere('experiment_collaborators', { experiment_id: id }),
      deleteWhere('experiment_samples', { experiment_id: id }),
      ...tagStatements('experiment', id, organizationId, document.tags),
    ];

    for (const userId of new Set(oidList(document.collaboratorUserIds))) {
      if (!knownUsers.has(userId)) continue;
      statements.push(insert('experiment_collaborators', { experiment_id: id, user_id: userId }));
    }
    for (const sampleId of samples) {
      statements.push(insert('experiment_samples', { experiment_id: id, sample_id: sampleId }));
    }

    /**
     * The FTS row, rebuilt explicitly.
     *
     * `trg_experiments_fts_insert` writes `samples` as the empty string, because at INSERT time
     * the `experiment_samples` rows do not exist. Nothing re-aggregates it afterwards unless the
     * experiment row is updated again, so a migrated corpus would be unsearchable by sample id —
     * which is the search scientists actually run. `experiment.repository.d1.ts` rebuilds the
     * row the same way after a sample write, for the same reason.
     *
     * A trashed experiment gets no row at all, reproducing the trigger's `WHERE deleted_at IS
     * NULL`: an index that cannot produce a trashed record is a stronger guarantee than a WHERE
     * clause every search has to remember.
     */
    statements.push(
      ...refreshExperimentFts(
        id,
        document.deletedAt ? null : { code, title, samples: samples.join(' '), objective },
      ),
    );

    return { kind: 'write', statements };
  },
});

export { tagStatements };
export type { StepContext };
