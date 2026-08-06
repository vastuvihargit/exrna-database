/**
 * Phase 3, module 3 — projects and experiments.
 *
 * The module where the Phase 2 data-model change lands: MongoDB stores project membership
 * twice and D1 stores it once. The exposed contract must not be able to tell.
 *
 * It is also the module with the sharpest internal asymmetry: `experiment.model.ts` applies
 * the soft-delete pre-hook and `project.model.ts` does not, so a trashed experiment disappears
 * from every listing while a trashed project does not. Both are asserted in both engines,
 * because the temptation to "fix" one of them is exactly what would break behaviour.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { startTestDb, stopTestDb, clearCollections } from '../helpers/test-db';
import { startTestD1, stopTestD1, clearD1 } from '../helpers/test-d1';
import { setD1BindingForTesting } from '@/server/db/d1-context';
import {
  d1ProjectRepository,
  mongoProjectRepository,
} from '@/server/repositories/project.repository';
import {
  d1ExperimentRepository,
  mongoExperimentRepository,
} from '@/server/repositories/experiment.repository';
import type {
  ProjectRecord,
  ProjectRepository,
} from '@/server/repositories/project.repository.contract';
import type {
  ExperimentRecord,
  ExperimentRepository,
} from '@/server/repositories/experiment.repository.contract';
import { clearDataSourceOverrides } from '@/server/repositories/data-source';

const ORG_A = '507f1f77bcf86cd799439011';
const ORG_B = '507f1f77bcf86cd799439012';
const ISO = '2026-01-01T00:00:00.000Z';

const ALICE = '507f1f77bcf86cd799439031';
const BOB = '507f1f77bcf86cd799439032';
const CAROL = '507f1f77bcf86cd799439033';
const DEPT_A = '507f1f77bcf86cd799439041';
const DEPT_B = '507f1f77bcf86cd799439042';

let d1: D1Database;

interface Engine {
  name: 'mongo' | 'd1';
  projects: ProjectRepository;
  experiments: ExperimentRepository;
  reset: () => Promise<void>;
}

/* ------------------------------------------------------------------ D1 fixtures */

async function seedD1World(): Promise<void> {
  for (const id of [ORG_A, ORG_B]) {
    await d1
      .prepare(
        `INSERT OR IGNORE INTO organizations
           (id, name, slug, email_domains, settings, storage_used_bytes, file_count, is_active, created_at, updated_at)
         VALUES (?, ?, ?, '[]', '{}', 0, 0, 1, ?, ?)`,
      )
      .bind(id, `Org ${id.slice(-2)}`, `org-${id.slice(-2)}`, ISO, ISO)
      .run();
  }

  for (const [id, email] of [
    [ALICE, 'alice@company.com'],
    [BOB, 'bob@company.com'],
    [CAROL, 'carol@company.com'],
  ] as const) {
    await d1
      .prepare(
        `INSERT OR IGNORE INTO users
           (id, organization_id, email, email_domain, name, mfa, preferences, status,
            is_super_admin, storage_quota_bytes, storage_used_bytes, must_change_password,
            failed_login_count, created_at, updated_at)
         VALUES (?, ?, ?, 'company.com', ?, '{"enabled":false}', '{}', 'active', 0, 1, 0, 0, 0, ?, ?)`,
      )
      .bind(id, ORG_A, email, email.split('@')[0], ISO, ISO)
      .run();
  }

  for (const [id, code] of [
    [DEPT_A, 'MB'],
    [DEPT_B, 'AD'],
  ] as const) {
    await d1
      .prepare(
        `INSERT OR IGNORE INTO departments
           (id, organization_id, name, code, description, storage_quota_bytes,
            storage_used_bytes, member_count, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, '', 1, 0, 0, 1, ?, ?)`,
      )
      .bind(id, ORG_A, `Dept ${code}`, code, ISO, ISO)
      .run();
  }
}

/* ------------------------------------------------------------------ harness */

beforeAll(async () => {
  const mongo = await startTestDb();
  if (!mongo.available) {
    throw new Error(
      `This suite asserts that the MongoDB and D1 repositories agree, so it needs both. ` +
        `MongoDB could not start: ${mongo.reason}`,
    );
  }
  d1 = await startTestD1();
  setD1BindingForTesting(d1);
  await seedD1World();
}, 300_000);

afterAll(async () => {
  setD1BindingForTesting(null);
  clearDataSourceOverrides();
  await stopTestD1();
  await stopTestDb();
});

/** Children before parents; `resource_tags` and the FTS table are not foreign-keyed to either. */
const D1_RESET = [
  'DELETE FROM experiment_samples',
  'DELETE FROM experiment_collaborators',
  'DELETE FROM experiments_fts',
  'DELETE FROM experiments',
  'DELETE FROM project_members',
  'DELETE FROM resource_tags',
  'DELETE FROM projects',
];

const ENGINES: Engine[] = [
  {
    name: 'mongo',
    projects: mongoProjectRepository,
    experiments: mongoExperimentRepository,
    reset: () => clearCollections(),
  },
  {
    name: 'd1',
    projects: d1ProjectRepository,
    experiments: d1ExperimentRepository,
    reset: async () => {
      await clearD1(d1, D1_RESET);
      await seedD1World();
    },
  },
];

/* ------------------------------------------------------------------ fixtures */

function makeProject(overrides: Partial<Parameters<ProjectRepository['create']>[0]> = {}) {
  return {
    organizationId: ORG_A,
    departmentId: DEPT_A,
    name: 'exRNA Discovery',
    code: 'exr-1',
    description: 'Extracellular RNA biomarkers',
    leadUserId: ALICE,
    memberUserIds: [ALICE, BOB],
    confidentiality: 'internal' as const,
    startDate: null,
    targetEndDate: null,
    tags: ['biomarkers', 'rna'],
    createdBy: ALICE,
    ...overrides,
  };
}

function makeExperiment(
  projectId: string,
  overrides: Partial<Parameters<ExperimentRepository['create']>[0]> = {},
) {
  return {
    organizationId: ORG_A,
    projectId,
    departmentId: DEPT_A,
    code: 'exp-001',
    title: 'Plasma extraction optimisation',
    objective: 'Compare column yields',
    leadUserId: ALICE,
    collaboratorUserIds: [BOB],
    protocolRef: 'PROTO-7',
    instrumentRef: 'NanoDrop',
    organism: 'Homo sapiens',
    sampleIds: ['S-4471', 'S-4472'],
    confidentiality: 'internal' as const,
    tags: ['plasma'],
    createdBy: ALICE,
    ...overrides,
  };
}

const VISIBLE_BASE = {
  organizationId: ORG_A,
  companyWide: false,
  departmentId: null,
  departmentScopeIds: [] as string[],
  projectScopeIds: [] as string[],
};

/* ------------------------------------------------------------------ comparators */

function comparableProject(
  record: ProjectRecord,
  aliases: Map<string, string>,
): Record<string, unknown> {
  const alias = (value: string | null) =>
    value === null ? null : (aliases.get(value) ?? value);
  const date = (value: Date | null) =>
    value === null ? null : value instanceof Date ? '<Date>' : `<not-a-Date:${typeof value}>`;

  return {
    ...record,
    id: alias(record.id),
    leadUserId: alias(record.leadUserId),
    rootFolderId: alias(record.rootFolderId),
    memberUserIds: [...record.memberUserIds].sort(),
    tags: [...record.tags].sort(),
    startDate: date(record.startDate),
    targetEndDate: date(record.targetEndDate),
    completedAt: date(record.completedAt),
    createdAt: date(record.createdAt),
  };
}

function comparableExperiment(
  record: ExperimentRecord,
  aliases: Map<string, string>,
): Record<string, unknown> {
  const alias = (value: string | null) =>
    value === null ? null : (aliases.get(value) ?? value);
  const date = (value: Date | null) =>
    value === null ? null : value instanceof Date ? '<Date>' : `<not-a-Date:${typeof value}>`;

  return {
    ...record,
    id: alias(record.id),
    projectId: alias(record.projectId),
    leadUserId: alias(record.leadUserId),
    folderId: alias(record.folderId),
    collaboratorUserIds: [...record.collaboratorUserIds].sort(),
    sampleIds: [...record.sampleIds].sort(),
    tags: [...record.tags].sort(),
    startedOn: date(record.startedOn),
    completedOn: date(record.completedOn),
    createdAt: date(record.createdAt),
    updatedAt: date(record.updatedAt),
  };
}

/* ================================================================== per-engine */

describe.each(ENGINES)('$name repositories', (engine) => {
  beforeEach(async () => {
    await engine.reset();
  });

  describe('projects', () => {
    it('upper-cases the code and round-trips members and tags', async () => {
      const created = await engine.projects.create(makeProject());

      expect(created.code).toBe('EXR-1');
      expect([...created.memberUserIds].sort()).toEqual([ALICE, BOB].sort());
      expect([...created.tags].sort()).toEqual(['biomarkers', 'rna']);
      expect(await engine.projects.findByCode(ORG_A, 'exr-1')).not.toBeNull();
    });

    it('replaces the whole member set on update', async () => {
      const created = await engine.projects.create(makeProject());

      const updated = await engine.projects.updateById(created.id, {
        memberUserIds: [BOB, CAROL],
      });
      expect([...updated!.memberUserIds].sort()).toEqual([BOB, CAROL].sort());
      // Alice is gone, not merged.
      expect(updated!.memberUserIds).not.toContain(ALICE);
    });

    it('replaces the whole tag set on update', async () => {
      const created = await engine.projects.create(makeProject());
      const updated = await engine.projects.updateById(created.id, { tags: ['exosomes'] });
      expect(updated!.tags).toEqual(['exosomes']);
    });

    it('leaves members and tags alone when the patch omits them', async () => {
      const created = await engine.projects.create(makeProject());
      const updated = await engine.projects.updateById(created.id, { name: 'Renamed' });

      expect(updated!.name).toBe('Renamed');
      expect([...updated!.memberUserIds].sort()).toEqual([ALICE, BOB].sort());
      expect([...updated!.tags].sort()).toEqual(['biomarkers', 'rna']);
    });

    it('shows a project to its members, its lead, and nobody else', async () => {
      const created = await engine.projects.create(
        makeProject({ leadUserId: ALICE, memberUserIds: [BOB] }),
      );

      const forBob = await engine.projects.listVisible({ ...VISIBLE_BASE, userId: BOB });
      expect(forBob.map((project) => project.id)).toEqual([created.id]);

      const forAlice = await engine.projects.listVisible({ ...VISIBLE_BASE, userId: ALICE });
      expect(forAlice.map((project) => project.id)).toEqual([created.id]);

      const forCarol = await engine.projects.listVisible({ ...VISIBLE_BASE, userId: CAROL });
      expect(forCarol).toEqual([]);
    });

    it('shows a project through a department scope grant', async () => {
      const created = await engine.projects.create(
        makeProject({ leadUserId: null, memberUserIds: [], departmentId: DEPT_A }),
      );

      const scoped = await engine.projects.listVisible({
        ...VISIBLE_BASE,
        userId: CAROL,
        departmentScopeIds: [DEPT_A],
      });
      expect(scoped.map((project) => project.id)).toEqual([created.id]);

      const otherDepartment = await engine.projects.listVisible({
        ...VISIBLE_BASE,
        userId: CAROL,
        departmentScopeIds: [DEPT_B],
      });
      expect(otherDepartment).toEqual([]);
    });

    it('returns nothing when an actor has no route to any project', async () => {
      await engine.projects.create(makeProject({ leadUserId: null, memberUserIds: [] }));
      // No userId, no department, no scopes — the absence of branches must mean "nothing",
      // never "the whole organization".
      const none = await engine.projects.listVisible({ ...VISIBLE_BASE, userId: '' });
      expect(none).toEqual([]);
    });

    it('never leaks a project from another organization to a company-wide reader', async () => {
      await engine.projects.create(makeProject({ code: 'AAA' }));
      await engine.projects.create(
        makeProject({ organizationId: ORG_B, code: 'BBB', departmentId: DEPT_A }),
      );

      const list = await engine.projects.listVisible({
        ...VISIBLE_BASE,
        companyWide: true,
        userId: ALICE,
      });
      expect(list.map((project) => project.code)).toEqual(['AAA']);
    });

    /**
     * `project.model.ts` does **not** call `applySoftDeleteFilter`, so a soft-deleted project
     * stays in the listing and `status: 'archived'` is what actually marks it.
     */
    it('keeps a soft-deleted project visible, matching MongoDB', async () => {
      const created = await engine.projects.create(makeProject());
      expect(await engine.projects.softDelete(created.id, ALICE)).toBe(true);

      const found = await engine.projects.findById(created.id);
      expect(found).not.toBeNull();
      expect(found!.status).toBe('archived');
    });
  });

  describe('experiments', () => {
    let projectId: string;

    beforeEach(async () => {
      const project = await engine.projects.create(makeProject());
      projectId = project.id;
    });

    it('upper-cases the code and round-trips collaborators, samples and tags', async () => {
      const created = await engine.experiments.create(makeExperiment(projectId));

      expect(created.code).toBe('EXP-001');
      expect(created.collaboratorUserIds).toEqual([BOB]);
      expect([...created.sampleIds].sort()).toEqual(['S-4471', 'S-4472']);
      expect(created.tags).toEqual(['plasma']);
    });

    it('finds an experiment by sample id', async () => {
      const created = await engine.experiments.create(makeExperiment(projectId));

      const { items, total } = await engine.experiments.list({
        organizationId: ORG_A,
        projectIds: [projectId],
        sampleId: 'S-4471',
        page: 1,
        pageSize: 20,
      });
      expect(total).toBe(1);
      expect(items[0]!.id).toBe(created.id);

      const miss = await engine.experiments.list({
        organizationId: ORG_A,
        projectIds: [projectId],
        sampleId: 'S-9999',
        page: 1,
        pageSize: 20,
      });
      expect(miss.total).toBe(0);
    });

    it('treats an empty visible-project set as nothing, never everything', async () => {
      await engine.experiments.create(makeExperiment(projectId));

      const { items, total } = await engine.experiments.list({
        organizationId: ORG_A,
        projectIds: [],
        page: 1,
        pageSize: 20,
      });
      expect(total).toBe(0);
      expect(items).toEqual([]);
    });

    it('never returns an experiment from a project the caller cannot see', async () => {
      await engine.experiments.create(makeExperiment(projectId));
      const other = await engine.projects.create(makeProject({ code: 'OTHER' }));

      const { total } = await engine.experiments.list({
        organizationId: ORG_A,
        projectIds: [other.id],
        page: 1,
        pageSize: 20,
      });
      expect(total).toBe(0);
    });

    /**
     * `experiment.model.ts` **does** apply the soft-delete pre-hook — the opposite of projects,
     * in the same module. A trashed experiment must vanish from every read.
     */
    it('hides a soft-deleted experiment from every read, matching MongoDB', async () => {
      const created = await engine.experiments.create(makeExperiment(projectId));
      expect(await engine.experiments.softDelete(created.id, ALICE)).toBe(true);

      expect(await engine.experiments.findById(created.id)).toBeNull();
      expect(await engine.experiments.findByIds([created.id])).toEqual([]);
      expect(await engine.experiments.findByCode(ORG_A, 'EXP-001')).toBeNull();
      expect(await engine.experiments.listForProject(projectId)).toEqual([]);

      const listed = await engine.experiments.list({
        organizationId: ORG_A,
        projectIds: [projectId],
        page: 1,
        pageSize: 20,
      });
      expect(listed.total).toBe(0);
      expect(await engine.experiments.countByStatusForProject(projectId)).toEqual({});
    });

    it('refuses to update a soft-deleted experiment', async () => {
      const created = await engine.experiments.create(makeExperiment(projectId));
      await engine.experiments.softDelete(created.id, ALICE);
      expect(await engine.experiments.updateById(created.id, { title: 'x' })).toBeNull();
    });

    it('counts experiments by status for the project dashboard', async () => {
      await engine.experiments.create(makeExperiment(projectId, { code: 'E1', status: 'planned' }));
      await engine.experiments.create(
        makeExperiment(projectId, { code: 'E2', status: 'in_progress' }),
      );
      await engine.experiments.create(makeExperiment(projectId, { code: 'E3', status: 'planned' }));

      expect(await engine.experiments.countByStatusForProject(projectId)).toEqual({
        planned: 2,
        in_progress: 1,
      });
    });

    it('adjusts the file count by a delta in both directions', async () => {
      const created = await engine.experiments.create(makeExperiment(projectId));

      await engine.experiments.adjustFileCount(created.id, 3);
      expect((await engine.experiments.findById(created.id))?.fileCount).toBe(3);

      await engine.experiments.adjustFileCount(created.id, -2);
      expect((await engine.experiments.findById(created.id))?.fileCount).toBe(1);

      await engine.experiments.adjustFileCount(created.id, 0);
      expect((await engine.experiments.findById(created.id))?.fileCount).toBe(1);
    });

    it('replaces sample and collaborator sets on update', async () => {
      const created = await engine.experiments.create(makeExperiment(projectId));

      const updated = await engine.experiments.updateById(created.id, {
        sampleIds: ['S-0001'],
        collaboratorUserIds: [CAROL],
      });
      expect(updated!.sampleIds).toEqual(['S-0001']);
      expect(updated!.collaboratorUserIds).toEqual([CAROL]);
    });

    it('lists a project’s experiments in code order', async () => {
      await engine.experiments.create(makeExperiment(projectId, { code: 'EXP-003' }));
      await engine.experiments.create(makeExperiment(projectId, { code: 'EXP-001' }));
      await engine.experiments.create(makeExperiment(projectId, { code: 'EXP-002' }));

      const list = await engine.experiments.listForProject(projectId);
      expect(list.map((experiment) => experiment.code)).toEqual([
        'EXP-001',
        'EXP-002',
        'EXP-003',
      ]);
    });
  });
});

/* ================================================================== parity */

describe('parity — the two implementations produce identical records', () => {
  beforeEach(async () => {
    await clearCollections();
    await clearD1(d1, D1_RESET);
    await seedD1World();
  });

  it('project records match field for field', async () => {
    const fromMongo = await mongoProjectRepository.create(makeProject());
    const fromD1 = await d1ProjectRepository.create(makeProject());

    expect(comparableProject(fromD1, new Map([[fromD1.id, '<project>']]))).toEqual(
      comparableProject(fromMongo, new Map([[fromMongo.id, '<project>']])),
    );
  });

  /**
   * The Phase 2 data-model change, proven at the contract: MongoDB reads
   * `projects.memberUserIds[]`, D1 reads `project_members`, and nothing above the repository
   * can tell which.
   */
  it('membership survives the move from an embedded array to a join table', async () => {
    const fromMongo = await mongoProjectRepository.create(
      makeProject({ memberUserIds: [ALICE, BOB, CAROL] }),
    );
    const fromD1 = await d1ProjectRepository.create(
      makeProject({ memberUserIds: [ALICE, BOB, CAROL] }),
    );

    expect([...fromD1.memberUserIds].sort()).toEqual([...fromMongo.memberUserIds].sort());
    expect([...fromD1.memberUserIds].sort()).toEqual([ALICE, BOB, CAROL].sort());

    // And the same after a membership replacement.
    const mongoUpdated = await mongoProjectRepository.updateById(fromMongo.id, {
      memberUserIds: [CAROL],
    });
    const d1Updated = await d1ProjectRepository.updateById(fromD1.id, {
      memberUserIds: [CAROL],
    });
    expect(d1Updated!.memberUserIds).toEqual(mongoUpdated!.memberUserIds);
  });

  it('listVisible returns the same projects for the same actor', async () => {
    for (const repository of [mongoProjectRepository, d1ProjectRepository]) {
      await repository.create(makeProject({ code: 'MINE', memberUserIds: [BOB] }));
      await repository.create(
        makeProject({ code: 'NOTMINE', leadUserId: null, memberUserIds: [] }),
      );
    }

    const input = { ...VISIBLE_BASE, userId: BOB };
    const fromMongo = await mongoProjectRepository.listVisible(input);
    const fromD1 = await d1ProjectRepository.listVisible(input);

    expect(fromD1.map((project) => project.code)).toEqual(
      fromMongo.map((project) => project.code),
    );
    expect(fromD1.map((project) => project.code)).toEqual(['MINE']);
  });

  it('experiment records match field for field', async () => {
    const mongoProject = await mongoProjectRepository.create(makeProject());
    const d1Project = await d1ProjectRepository.create(makeProject());

    const fromMongo = await mongoExperimentRepository.create(makeExperiment(mongoProject.id));
    const fromD1 = await d1ExperimentRepository.create(makeExperiment(d1Project.id));

    const mongoAliases = new Map([
      [fromMongo.id, '<experiment>'],
      [mongoProject.id, '<project>'],
    ]);
    const d1Aliases = new Map([
      [fromD1.id, '<experiment>'],
      [d1Project.id, '<project>'],
    ]);

    expect(comparableExperiment(fromD1, d1Aliases)).toEqual(
      comparableExperiment(fromMongo, mongoAliases),
    );
  });

  it('the soft-delete asymmetry is identical in both databases', async () => {
    for (const [projectRepo, experimentRepo] of [
      [mongoProjectRepository, mongoExperimentRepository],
      [d1ProjectRepository, d1ExperimentRepository],
    ] as const) {
      const project = await projectRepo.create(makeProject());
      const experiment = await experimentRepo.create(makeExperiment(project.id));

      await projectRepo.softDelete(project.id, ALICE);
      await experimentRepo.softDelete(experiment.id, ALICE);

      // Project: still readable. Experiment: gone.
      expect(await projectRepo.findById(project.id)).not.toBeNull();
      expect(await experimentRepo.findById(experiment.id)).toBeNull();
    }
  });
});

/* ================================================================== d1 specifics */

describe('d1 specifics', () => {
  let projectId: string;

  beforeEach(async () => {
    await clearD1(d1, D1_RESET);
    await seedD1World();
    projectId = (await d1ProjectRepository.create(makeProject())).id;
  });

  /**
   * The insert trigger writes `samples` as `''`, because sample rows are written after the
   * parent. The repository's explicit re-index is what makes a brand-new experiment findable
   * by the sample id printed on its tubes.
   */
  it('indexes samples for full-text search on create, not just on update', async () => {
    await d1ExperimentRepository.create(makeExperiment(projectId));

    const row = await d1
      .prepare('SELECT samples FROM experiments_fts LIMIT 1')
      .first<{ samples: string }>();
    expect(row?.samples).toContain('S-4471');

    const { total } = await d1ExperimentRepository.list({
      organizationId: ORG_A,
      projectIds: [projectId],
      text: 'S-4471',
      page: 1,
      pageSize: 20,
    });
    expect(total).toBe(1);
  });

  it('ranks a code match above an objective match, using the documented weights', async () => {
    await d1ExperimentRepository.create(
      makeExperiment(projectId, {
        code: 'PLASMA-1',
        title: 'Unrelated title',
        objective: 'Nothing to see',
        sampleIds: [],
      }),
    );
    await d1ExperimentRepository.create(
      makeExperiment(projectId, {
        code: 'EXP-777',
        title: 'Unrelated title',
        objective: 'A study of plasma handling',
        sampleIds: [],
      }),
    );

    const { items } = await d1ExperimentRepository.list({
      organizationId: ORG_A,
      projectIds: [projectId],
      text: 'plasma',
      page: 1,
      pageSize: 20,
    });

    expect(items).toHaveLength(2);
    // bm25 returns a negative score, so "better" sorts first ascending. If the weights were
    // shifted by one — the classic FTS5 mistake of omitting the UNINDEXED column — the
    // objective match would win here.
    expect(items[0]!.code).toBe('PLASMA-1');
  });

  /**
   * FTS5 has a query language. `-` is NOT, `*` is a wildcard, `:` filters a column, and an
   * unbalanced quote is a syntax error — so a raw search term does not merely fail to match,
   * it throws, turning the search box into a 500. MongoDB's `$text` has no such hazard, so
   * this is one the migration introduces.
   */
  it.each([
    ['a hyphenated sample id', 'S-4471'],
    ['an unbalanced quote', 'plasma"'],
    ['a column filter', 'code:EXP'],
    ['a bare NOT operator', '-plasma'],
    ['a wildcard', 'pla*'],
    ['a NEAR operator', 'NEAR(plasma handling)'],
    ['punctuation only', '***'],
    ['an empty string', ''],
  ])('survives %s in the search box', async (_label, term) => {
    await d1ExperimentRepository.create(makeExperiment(projectId));

    await expect(
      d1ExperimentRepository.list({
        organizationId: ORG_A,
        projectIds: [projectId],
        text: term,
        page: 1,
        pageSize: 20,
      }),
    ).resolves.toBeDefined();
  });

  it('treats a term with no searchable characters as no results, not all results', async () => {
    await d1ExperimentRepository.create(makeExperiment(projectId));

    const { total } = await d1ExperimentRepository.list({
      organizationId: ORG_A,
      projectIds: [projectId],
      text: '***',
      page: 1,
      pageSize: 20,
    });
    expect(total).toBe(0);
  });

  /** MongoDB's `$text` ORs space-separated terms; FTS5 defaults to AND. */
  it('ORs search terms, as MongoDB does', async () => {
    await d1ExperimentRepository.create(
      makeExperiment(projectId, { code: 'E1', title: 'plasma only', sampleIds: [] }),
    );
    await d1ExperimentRepository.create(
      makeExperiment(projectId, { code: 'E2', title: 'handling only', sampleIds: [] }),
    );

    const { total } = await d1ExperimentRepository.list({
      organizationId: ORG_A,
      projectIds: [projectId],
      text: 'plasma handling',
      page: 1,
      pageSize: 20,
    });
    // AND semantics would return 0 here.
    expect(total).toBe(2);
  });

  it('removes a trashed experiment from the search index rather than filtering it later', async () => {
    const created = await d1ExperimentRepository.create(makeExperiment(projectId));
    await d1ExperimentRepository.softDelete(created.id, ALICE);

    const rows = await d1
      .prepare('SELECT COUNT(*) AS c FROM experiments_fts WHERE experiment_id = ?')
      .bind(created.id)
      .first<{ c: number }>();
    expect(rows!.c).toBe(0);
  });

  it('rolls the whole project create back if any statement fails', async () => {
    const before = await d1.prepare('SELECT COUNT(*) AS c FROM projects').first<{ c: number }>();

    // Duplicate code violates ux_projects_org_code.
    await expect(d1ProjectRepository.create(makeProject())).rejects.toThrow();

    const after = await d1.prepare('SELECT COUNT(*) AS c FROM projects').first<{ c: number }>();
    const members = await d1
      .prepare('SELECT COUNT(*) AS c FROM project_members')
      .first<{ c: number }>();

    expect(after!.c).toBe(before!.c);
    // The first project's two members survive; the failed one contributed none.
    expect(members!.c).toBe(2);
  });

  it('does not duplicate members when the same user is listed twice', async () => {
    const created = await d1ProjectRepository.create(
      makeProject({ code: 'DUP', memberUserIds: [ALICE, ALICE, BOB] }),
    );
    expect([...created.memberUserIds].sort()).toEqual([ALICE, BOB].sort());
  });
});
