/**
 * Pre-flight check on MongoDB, before any cutover window is opened.
 *
 *   npm run migrate:validate
 *   npm run migrate:validate -- --json
 *
 * Read-only. Reports the data-quality problems that are harmless in MongoDB and are a batch
 * abort in D1 — duplicate values under a unique index, enum values outside a CHECK constraint,
 * references that cannot be satisfied, and ACL arrays that resolve to fewer entries than they
 * contain.
 *
 * Exit code is 1 when a **blocker** is present, so this can gate the cutover in a script. The
 * migration runs the same checks itself and refuses to write past a blocker; this exists so the
 * answer is known days beforehand rather than during the freeze.
 */
import './load-dotenv';

import { connectToDatabase } from '@/server/db/connection';
import { validateSource } from '@/server/migration/d1/validate-source';

async function main(): Promise<void> {
  await connectToDatabase();
  const report = await validateSource();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('MongoDB source validation (read-only)\n');
    if (report.issues.length === 0) {
      console.log('No issues. Every constraint the D1 schema declares is already satisfied.');
    }
    for (const issue of report.issues) {
      console.log(`[${issue.severity}] ${issue.check} — ${issue.count}`);
      console.log(`  ${issue.detail}`);
      for (const sample of issue.sample.slice(0, 10)) console.log(`    ${sample}`);
      console.log('');
    }
    console.log(report.ok ? 'PASS — no blockers' : 'FAIL — blockers present');
  }

  if (!report.ok) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    const mongoose = (await import('mongoose')).default;
    await mongoose.disconnect();
  });
