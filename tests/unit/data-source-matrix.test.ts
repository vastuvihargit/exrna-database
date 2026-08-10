/**
 * The `DATA_SOURCE_*` flag matrix.
 *
 * This guard exists because a split configuration does not degrade gracefully. If
 * `DATA_SOURCE_SESSIONS=d1` while users are still on MongoDB, reads keep working and
 * `/api/health/ready` stays green — only *writes* fail, only in that module, and only when
 * somebody tries to log in. That is a support ticket rather than an outage, which is precisely
 * why it needs to be caught at startup instead of discovered.
 *
 * The assertions below are about three properties:
 *
 *   1. the default (everything unset) is clean, so the guard cannot break a MongoDB deployment;
 *   2. a genuine split is refused, and the message names the pair;
 *   3. requirements resolve **transitively**, so one boot reports every missing flag rather
 *      than one per restart cycle.
 *
 * Plus one structural check: every dependency named in the table must be a real module, since a
 * typo there would silently disable the guard for that edge.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertDataSourceMatrix,
  DATA_SOURCE_DEPENDENCIES,
  DATA_SOURCE_MODULES,
  dataSourceViolations,
  envVarFor,
  UnsafeDataSourceMatrixError,
  workerReadinessGaps,
  type DataSourceModule,
} from '@/server/repositories/data-source';

/**
 * Drives `process.env` rather than `setDataSourceOverride`, deliberately.
 *
 * The matrix validates how the *deployment* is configured, so it reads the environment and
 * ignores the per-module test overrides — otherwise a suite that puts folders on D1 and files on
 * Mongo, precisely to prove the hierarchy layer refuses that pair with its own error, would have
 * this guard throw first and pre-empt the assertion. Testing it through overrides would test a
 * path production never takes.
 */
const touched: string[] = [];

function onD1(...modules: DataSourceModule[]): void {
  for (const name of modules) {
    const key = envVarFor(name);
    touched.push(key);
    process.env[key] = 'd1';
  }
}

afterEach(() => {
  for (const key of touched.splice(0)) delete process.env[key];
});

describe('the default configuration', () => {
  it('reports no violations when every module is on MongoDB', () => {
    expect(dataSourceViolations()).toEqual([]);
    expect(() => assertDataSourceMatrix()).not.toThrow();
  });

  it('reports every module as a Worker readiness gap', () => {
    expect(workerReadinessGaps()).toEqual([...DATA_SOURCE_MODULES]);
  });
});

describe('a split that would cross a foreign key', () => {
  it('refuses sessions on D1 while identity is on MongoDB', () => {
    onD1('sessions');

    const violations = dataSourceViolations();
    expect(violations.map((violation) => violation.requires).sort()).toEqual([
      'organizations',
      'users',
    ]);
    expect(() => assertDataSourceMatrix()).toThrow(UnsafeDataSourceMatrixError);
  });

  it('names both variables in the message, so the fix needs no lookup', () => {
    onD1('sessions');

    const [first] = dataSourceViolations();
    expect(first!.message).toContain('DATA_SOURCE_SESSIONS=d1');
    expect(first!.message).toMatch(/DATA_SOURCE_(ORGANIZATIONS|USERS)=d1/);
  });

  /**
   * The property the transitive resolution exists for.
   *
   * `fileVersions` names `files`, `files` names `folders`, `folders` names `departments`. An
   * operator told only about `files` would fix it, restart, and be told about `folders` — three
   * restarts to learn one answer, during a write freeze.
   */
  it('reports the whole transitive chain in one pass', () => {
    onD1('fileVersions');

    const required = dataSourceViolations().map((violation) => violation.requires);

    expect(required).toContain('files');
    expect(required).toContain('folders');
    expect(required).toContain('departments');
    expect(required).toContain('organizations');
    expect(required).toContain('users');
  });

  it('falls silent once the whole chain is on D1', () => {
    onD1('fileVersions', 'files', 'folders', 'departments', 'organizations', 'users');

    expect(dataSourceViolations()).toEqual([]);
    expect(() => assertDataSourceMatrix()).not.toThrow();
  });

  it('accepts a module with no dependencies on its own', () => {
    onD1('organizations');
    expect(dataSourceViolations()).toEqual([]);
  });

  it('collects violations across several modules rather than stopping at the first', () => {
    onD1('sessions', 'reviews');

    const offenders = new Set(dataSourceViolations().map((violation) => violation.module));
    expect(offenders).toEqual(new Set(['sessions', 'reviews']));
  });
});

describe('the table itself', () => {
  /** A typo in a dependency name silently disables the guard for that edge. */
  it('names only real modules', () => {
    const known = new Set<string>(DATA_SOURCE_MODULES);

    for (const [name, requirements] of Object.entries(DATA_SOURCE_DEPENDENCIES)) {
      expect(known, `${name} is not a known module`).toContain(name);
      for (const requirement of requirements ?? []) {
        expect(known, `${name} requires unknown module ${requirement}`).toContain(requirement);
      }
    }
  });

  it('has no module depending on itself', () => {
    for (const [name, requirements] of Object.entries(DATA_SOURCE_DEPENDENCIES)) {
      expect(requirements ?? []).not.toContain(name);
    }
  });

  /**
   * A cycle would make `transitiveRequirements` loop for ever at startup — a worse failure than
   * the misconfiguration it is checking for. The `seen` set already prevents the hang; this
   * asserts the table has no cycle in the first place, so the guard is a real property rather
   * than a rescue.
   */
  it('is acyclic', () => {
    const visiting = new Set<string>();
    const done = new Set<string>();

    const visit = (name: string, path: string[]): void => {
      if (done.has(name)) return;
      expect(visiting.has(name), `dependency cycle: ${[...path, name].join(' → ')}`).toBe(false);

      visiting.add(name);
      for (const requirement of DATA_SOURCE_DEPENDENCIES[name as DataSourceModule] ?? []) {
        visit(requirement, [...path, name]);
      }
      visiting.delete(name);
      done.add(name);
    };

    for (const name of DATA_SOURCE_MODULES) visit(name, []);
  });

  it('derives the environment variable name from the module name', () => {
    expect(envVarFor('users')).toBe('DATA_SOURCE_USERS');
    expect(envVarFor('fileVersions')).toBe('DATA_SOURCE_FILE_VERSIONS');
    expect(envVarFor('auditLogs')).toBe('DATA_SOURCE_AUDIT_LOGS');
    expect(envVarFor('uploadSessions')).toBe('DATA_SOURCE_UPLOAD_SESSIONS');
  });
});
