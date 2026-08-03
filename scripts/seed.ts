/**
 * Seeds an organization, the system roles, departments and a first administrator.
 *
 * Idempotent: running it twice does not duplicate anything, so it is safe to run on
 * every deploy to pick up newly added system roles.
 *
 *   npx tsx scripts/seed.ts --admin-email you@company.com --admin-password '…' --demo
 */
import './load-dotenv';

import { loadEnv } from '../src/server/config/env';
import { connectToDatabase, disconnectFromDatabase } from '../src/server/db/connection';
import {
  DepartmentModel,
  FolderModel,
  OrganizationModel,
  RoleModel,
  UserModel,
  UserRoleModel,
  syncAllIndexes,
} from '../src/server/db/models';
import { DEFAULT_ROLES } from '../src/server/domain/roles';
import {
  DEFAULT_DEPARTMENT_TEMPLATE,
  flattenTemplate,
} from '../src/server/domain/folder-templates';
import { hashPassword, checkPasswordPolicy } from '../src/server/auth/password';
import { normalizeCompanyEmail } from '../src/server/auth/email-domain';

interface Args {
  adminEmail?: string;
  adminPassword?: string;
  adminName?: string;
  demoPassword?: string;
  demo: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { demo: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--demo') args.demo = true;
    if (key === '--admin-email') args.adminEmail = argv[++i];
    if (key === '--admin-password') args.adminPassword = argv[++i];
    if (key === '--admin-name') args.adminName = argv[++i];
    if (key === '--demo-password') args.demoPassword = argv[++i];
  }
  return args;
}

/**
 * The password every demo account shares, so that they are usable from the login form
 * as well as the development switcher. Overridable with `--demo-password`, and the
 * accounts it belongs to only ever exist because somebody passed `--demo`.
 */
const DEFAULT_DEMO_PASSWORD = 'Drive-Demo-2026!';

/**
 * The demo cast.
 *
 * Three people rather than one, because a permission system with a single super admin
 * in it is a permission system nobody is actually testing: every check passes, so no
 * check is exercised. These three sit at deliberately different heights — a department
 * head who can approve, a scientist who can contribute, a technician who can upload but
 * not delete — and in *different departments*, which is what makes cross-department
 * visibility visible at all.
 *
 * All of them are on a company email domain: `normalizeCompanyEmail` rejects anything
 * else at login, so an account on some other domain would appear in the switcher and
 * then fail every other way into the app.
 */
const DEMO_USERS: Array<{
  localPart: string;
  name: string;
  jobTitle: string;
  roleKey: string;
  departmentCode: string;
}> = [
  {
    localPart: 'maya.okonkwo',
    name: 'Maya Okonkwo',
    jobTitle: 'Head of Molecular Biology',
    roleKey: 'department_head',
    departmentCode: 'MOLBIO',
  },
  {
    localPart: 'tomas.lindqvist',
    name: 'Tomas Lindqvist',
    jobTitle: 'Senior Research Scientist',
    roleKey: 'research_scientist',
    departmentCode: 'BIOINF',
  },
  {
    localPart: 'priya.raman',
    name: 'Priya Raman',
    jobTitle: 'Lab Technician',
    roleKey: 'lab_technician',
    departmentCode: 'ANCHEM',
  },
];

async function main() {
  const env = loadEnv();
  const args = parseArgs(process.argv.slice(2));

  console.log(`Seeding ${env.MONGODB_DATABASE} (${env.NODE_ENV})`);
  await connectToDatabase();
  await syncAllIndexes();
  console.log('✓ Indexes synced');

  // ── Organization ──────────────────────────────────────────────────────────
  const primaryDomain = env.COMPANY_EMAIL_DOMAINS[0]!;
  const slug = primaryDomain.split('.')[0]!;

  let organization = await OrganizationModel.findOne({ slug }).exec();
  if (!organization) {
    organization = await OrganizationModel.create({
      name: `${slug.charAt(0).toUpperCase()}${slug.slice(1)} Research`,
      slug,
      emailDomains: [...env.COMPANY_EMAIL_DOMAINS],
      settings: {
        allowAutoProvisioning: env.ALLOW_AUTO_PROVISIONING,
        defaultUserQuotaBytes: env.defaultUserQuotaBytes,
        defaultDepartmentQuotaBytes: env.defaultDepartmentQuotaBytes,
        maxUploadBytes: env.maxUploadBytes,
        trashRetentionDays: env.TRASH_RETENTION_DAYS,
      },
    });
    console.log(`✓ Organization created: ${organization.name}`);
  } else {
    console.log(`• Organization exists: ${organization.name}`);
  }

  const organizationId = organization._id;

  // ── System roles ──────────────────────────────────────────────────────────
  let created = 0;
  let updated = 0;
  for (const definition of DEFAULT_ROLES) {
    const result = await RoleModel.updateOne(
      { organizationId, key: definition.key },
      {
        $set: {
          name: definition.name,
          description: definition.description,
          permissions: definition.permissions,
          scopeTypes: definition.scopeTypes,
          rank: definition.rank,
          maxConfidentiality: definition.maxConfidentiality,
          companyWideRead: definition.companyWideRead,
          isSystem: true,
        },
        $setOnInsert: { organizationId, key: definition.key },
      },
      { upsert: true },
    ).exec();

    if (result.upsertedCount) created += 1;
    else if (result.modifiedCount) updated += 1;
  }
  console.log(`✓ Roles: ${created} created, ${updated} updated, ${DEFAULT_ROLES.length} total`);

  // ── Departments ───────────────────────────────────────────────────────────
  const departmentSeeds = args.demo
    ? [
        { name: 'Molecular Biology', code: 'MOLBIO', description: 'Nucleic acid extraction, sequencing and assays' },
        { name: 'Analytical Chemistry', code: 'ANCHEM', description: 'HPLC, mass spectrometry and stability studies' },
        { name: 'Bioinformatics', code: 'BIOINF', description: 'Pipelines, analysis and data science' },
      ]
    : [{ name: 'Research & Development', code: 'RND', description: 'Default department' }];

  for (const seed of departmentSeeds) {
    await DepartmentModel.updateOne(
      { organizationId, code: seed.code },
      {
        $setOnInsert: {
          organizationId,
          code: seed.code,
          name: seed.name,
          description: seed.description,
          storageQuotaBytes: env.defaultDepartmentQuotaBytes,
        },
      },
      { upsert: true },
    ).exec();
  }
  console.log(`✓ Departments: ${departmentSeeds.length} ensured`);

  // ── First administrator ───────────────────────────────────────────────────
  if (args.adminEmail) {
    const email = normalizeCompanyEmail(args.adminEmail, env.COMPANY_EMAIL_DOMAINS);
    if (!email) {
      throw new Error(
        `--admin-email must be on an approved company domain (${env.COMPANY_EMAIL_DOMAINS.join(', ')})`,
      );
    }

    const existing = await UserModel.findOne({ email }).exec();
    if (existing) {
      console.log(`• Administrator already exists: ${email}`);
    } else {
      if (!args.adminPassword) {
        throw new Error('--admin-password is required when creating the first administrator');
      }
      const name = args.adminName ?? email.split('@')[0]!;
      const policy = checkPasswordPolicy(args.adminPassword, { email, name });
      if (!policy.ok) {
        throw new Error(`Administrator password rejected:\n  - ${policy.problems.join('\n  - ')}`);
      }

      const department = await DepartmentModel.findOne({ organizationId }).exec();

      const admin = await UserModel.create({
        organizationId,
        email,
        emailDomain: email.split('@')[1]!,
        name,
        status: 'active',
        isSuperAdmin: true,
        departmentId: department?._id ?? null,
        storageQuotaBytes: env.defaultUserQuotaBytes,
        passwordHash: await hashPassword(args.adminPassword),
        passwordUpdatedAt: new Date(),
        activatedAt: new Date(),
        authProviders: [{ provider: 'password' }],
      });

      const superAdminRole = await RoleModel.findOne({ organizationId, key: 'super_admin' }).exec();
      if (superAdminRole) {
        await UserRoleModel.create({
          organizationId,
          userId: admin._id,
          roleId: superAdminRole._id,
          scopeType: 'company',
          scopeId: null,
          grantedAt: new Date(),
        });
      }

      console.log(`✓ Administrator created: ${email}`);
      console.log('  Sign in at /login and change this password immediately.');
    }
  } else {
    const adminCount = await UserModel.countDocuments({ organizationId, isSuperAdmin: true }).exec();
    if (adminCount === 0) {
      console.log('\n⚠ No administrator exists yet. Create one with:');
      console.log(
        `   npx tsx scripts/seed.ts --admin-email you@${primaryDomain} --admin-password '<strong password>'`,
      );
    }
  }

  // ── Demo accounts ─────────────────────────────────────────────────────────
  // Only with `--demo`, and only ever on a non-production database: these are accounts
  // with a shared, printed password, which is fine for a laptop and unacceptable
  // anywhere else.
  if (args.demo) {
    if (env.isProduction) {
      throw new Error('--demo refuses to run against a production environment');
    }

    const demoPassword = args.demoPassword ?? DEFAULT_DEMO_PASSWORD;
    const departmentsByCode = new Map(
      (await DepartmentModel.find({ organizationId }).exec()).map((d) => [d.code, d]),
    );
    // Hashed once rather than per user: Argon2id at 64 MiB is deliberately slow, and
    // three identical hashes of the same string prove nothing extra.
    const demoPasswordHash = await hashPassword(demoPassword);

    let demoCreated = 0;
    let demoExisting = 0;

    for (const seed of DEMO_USERS) {
      const email = `${seed.localPart}@${primaryDomain}`;
      const policy = checkPasswordPolicy(demoPassword, { email, name: seed.name });
      if (!policy.ok) {
        throw new Error(`Demo password rejected:\n  - ${policy.problems.join('\n  - ')}`);
      }

      const department = departmentsByCode.get(seed.departmentCode);
      const role = await RoleModel.findOne({ organizationId, key: seed.roleKey }).exec();

      let user = await UserModel.findOne({ email }).exec();
      if (user) {
        demoExisting += 1;
      } else {
        user = await UserModel.create({
          organizationId,
          email,
          emailDomain: primaryDomain,
          name: seed.name,
          jobTitle: seed.jobTitle,
          status: 'active',
          isSuperAdmin: false,
          departmentId: department?._id ?? null,
          storageQuotaBytes: env.defaultUserQuotaBytes,
          passwordHash: demoPasswordHash,
          passwordUpdatedAt: new Date(),
          activatedAt: new Date(),
          authProviders: [{ provider: 'password' }],
        });
        demoCreated += 1;
      }

      // Granted on every run, not just on creation: a re-seed after a role was revoked
      // by hand should put the demo cast back the way it describes itself.
      if (role && department) {
        await UserRoleModel.updateOne(
          {
            organizationId,
            userId: user._id,
            roleId: role._id,
            scopeType: 'department',
            scopeId: department._id,
          },
          {
            $setOnInsert: {
              organizationId,
              userId: user._id,
              roleId: role._id,
              scopeType: 'department',
              scopeId: department._id,
              grantedAt: new Date(),
            },
            $set: { revokedAt: null, revokedBy: null },
          },
          { upsert: true },
        ).exec();
      }
    }

    console.log(`✓ Demo accounts: ${demoCreated} created, ${demoExisting} already present`);
    for (const seed of DEMO_USERS) {
      console.log(`   ${seed.localPart}@${primaryDomain} — ${seed.name} (${seed.jobTitle})`);
    }
    console.log(`   Shared password: ${demoPassword}`);
  }

  // ── Department drives ─────────────────────────────────────────────────────
  // Roots are also created lazily on first open; seeding them means a fresh install
  // has somewhere to put a file before anyone has clicked anything.
  const owner =
    (await UserModel.findOne({ organizationId, isSuperAdmin: true }).exec()) ??
    (await UserModel.findOne({ organizationId }).exec());

  if (owner) {
    const departments = await DepartmentModel.find({ organizationId }).exec();
    let drivesCreated = 0;

    for (const department of departments) {
      const rootKey = `department:${String(department._id)}`;
      const existingRoot = await FolderModel.findOne({ rootKey }).exec();
      if (existingRoot) continue;

      const root = await FolderModel.create({
        organizationId,
        name: department.name,
        nameLower: department.name.toLowerCase(),
        parentFolderId: null,
        pathAncestors: [],
        depth: 0,
        driveType: 'department',
        rootKey,
        ownerId: department.headUserId ?? owner._id,
        departmentId: department._id,
        confidentiality: 'internal',
        isSystem: true,
        createdBy: owner._id,
      });

      for (const entry of flattenTemplate(DEFAULT_DEPARTMENT_TEMPLATE)) {
        await FolderModel.create({
          organizationId,
          name: entry.name,
          nameLower: entry.name.toLowerCase(),
          parentFolderId: root._id,
          pathAncestors: [root._id],
          depth: 1,
          driveType: 'department',
          ownerId: root.ownerId,
          departmentId: department._id,
          confidentiality: 'internal',
          description: entry.description,
          templateKey: entry.key,
          isSystem: true,
          createdBy: owner._id,
        });
      }

      await FolderModel.updateOne(
        { _id: root._id },
        { $set: { childFolderCount: DEFAULT_DEPARTMENT_TEMPLATE.length } },
      ).exec();
      await DepartmentModel.updateOne(
        { _id: department._id },
        { $set: { rootFolderId: root._id } },
      ).exec();
      drivesCreated += 1;
    }

    console.log(`✓ Department drives: ${drivesCreated} created, ${departments.length} total`);
  } else {
    console.log('• Department drives skipped — no user to own them yet');
  }

  await disconnectFromDatabase();
  console.log('\nSeed complete.');
}

main().catch(async (error: unknown) => {
  console.error('✗ Seed failed');
  console.error(error instanceof Error ? error.message : error);
  await disconnectFromDatabase().catch(() => undefined);
  process.exit(1);
});
