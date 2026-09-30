/**
 * First-login bootstrap for a fresh D1 database: organization, system roles, one Super Admin.
 *
 *   npm run bootstrap:d1 -- --env staging --remote --admin-email you@exrna.com            dry run
 *   npm run bootstrap:d1 -- --env staging --remote --admin-email you@exrna.com --write    apply
 *
 * For a deployment that has no MongoDB data to migrate. Where there is data, `migrate:d1` is the
 * tool, and it copies the organization, roles and users itself — do not run both.
 *
 * **Dry run is the default**, as with `migrate:d1`: it reads the target, prints the statements it
 * would apply and changes nothing. `--write` applies them as one file (one wrangler call), and
 * production additionally needs `--confirm production`.
 *
 * Safe to re-run: every statement is keyed on a unique natural key and never modifies an
 * existing row (`src/server/migration/d1/bootstrap.ts`). The run ends by re-reading the database
 * and exits non-zero unless the administrator can sign in and nothing is duplicated.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DryRunGateway,
  WranglerGateway,
  defaultWorkDir,
  renderStatement,
} from '@/server/migration/d1/gateway';
import {
  bootstrapProblems,
  planBootstrap,
  readBootstrapState,
  type BootstrapState,
} from '@/server/migration/d1/bootstrap';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

interface Options {
  write: boolean;
  env: string;
  database: string;
  remote: boolean;
  persistTo: string | null;
  adminEmail: string;
  adminName: string | null;
  organizationName: string;
  organizationSlug: string;
  emailDomains: string[];
}

function parseArgs(argv: string[]): Options {
  const value = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    if (index === -1) return null;
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`${flag} needs a value`);
    return next;
  };

  const env = value('--env');
  if (!env) throw new Error('--env is required (development, staging or production)');
  const adminEmail = value('--admin-email');
  if (!adminEmail) throw new Error('--admin-email is required');

  const write = argv.includes('--write');
  if (write && env === 'production' && value('--confirm') !== 'production') {
    throw new Error('Writing to production requires --confirm production');
  }

  const adminDomain = adminEmail.split('@')[1]?.trim().toLowerCase() ?? '';
  const emailDomains = (value('--email-domains') ?? adminDomain)
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
  // The seed script's convention, so a bootstrapped and a seeded organization look alike.
  const slug = value('--org-slug') ?? (emailDomains[0] ?? adminDomain).split('.')[0]!;

  return {
    write,
    env,
    database: value('--database') ?? `biotech-drive-${env === 'development' ? 'dev' : env}`,
    remote: argv.includes('--remote'),
    persistTo: value('--persist-to'),
    adminEmail,
    adminName: value('--admin-name'),
    organizationName: value('--org-name') ?? `${slug.charAt(0).toUpperCase()}${slug.slice(1)} Research`,
    organizationSlug: slug,
    emailDomains,
  };
}

/** See `migrate-to-d1.ts`: `src/server/**` does not touch the filesystem, so the script does. */
async function writeSql(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, 'utf8');
}

function printState(label: string, state: BootstrapState): void {
  console.log(`\n${label}`);
  console.log(
    `  organizations ${state.organizations} (with slug: ${state.organizationsWithSlug}), ` +
      `roles ${state.roles} (system roles present: ${state.systemRolesPresent}), ` +
      `role permissions ${state.rolePermissions}, role scope types ${state.roleScopeTypes}, users ${state.users}`,
  );
  console.log(
    state.admin
      ? `  administrator ${state.admin.id}: status ${state.admin.status}, super admin ${state.admin.isSuperAdmin}, ` +
          `in organization ${state.admin.organizationMatches}, active super_admin grants ${state.admin.activeSuperAdminGrants}`
      : '  administrator: not present',
  );
  console.log(`  duplicates ${JSON.stringify(state.duplicates)}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const runId = `bootstrap-${options.env}-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  const target = new WranglerGateway({
    database: options.database,
    env: options.env,
    remote: options.remote,
    ...(options.persistTo ? { persistTo: options.persistTo } : {}),
    workDir: defaultWorkDir(runId),
    writeSql,
  });
  const gateway = options.write ? target : new DryRunGateway(target, Number.MAX_SAFE_INTEGER);

  const plan = planBootstrap({
    adminEmail: options.adminEmail,
    ...(options.adminName ? { adminName: options.adminName } : {}),
    organizationName: options.organizationName,
    organizationSlug: options.organizationSlug,
    emailDomains: options.emailDomains,
    // The Node and Worker environment defaults (`env.ts`), which is what `seed.ts` writes when
    // nothing overrides them. Administrators change them in the application afterwards.
    defaultUserQuotaBytes: 20 * GB,
    defaultDepartmentQuotaBytes: 500 * GB,
    maxUploadBytes: 2048 * MB,
    trashRetentionDays: 30,
  });
  const lookup = { organizationSlug: options.organizationSlug, adminEmail: plan.adminEmail };

  console.log(`${gateway.label}`);
  console.log(
    `Organization "${options.organizationName}" (slug ${options.organizationSlug}, domains ` +
      `${options.emailDomains.join(', ')}); Super Admin ${plan.adminEmail}`,
  );

  printState('Before', await readBootstrapState(gateway, lookup));

  await gateway.run(plan.statements);

  if (gateway instanceof DryRunGateway) {
    const file = path.join(defaultWorkDir(runId), 'planned.sql');
    await writeSql(file, `${plan.statements.map(renderStatement).join('\n')}\n`);
    console.log(`\nDRY RUN — nothing was written. ${gateway.statementsSeen} statement(s) planned: ${file}`);
    return;
  }

  const after = await readBootstrapState(gateway, lookup);
  printState('After', after);

  const problems = bootstrapProblems(after);
  if (problems.length > 0) {
    console.error('\nNOT READY for first sign-in:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nREADY: ${plan.adminEmail} is an active Super Admin with one company-scope grant; nothing duplicated.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
