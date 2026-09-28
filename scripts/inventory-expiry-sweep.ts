/**
 * Writes off inventory stock that is past its expiry date.
 *
 * The Node deployment's scheduled job (`docker/scheduler/crontab`). On the Cloudflare Worker
 * the same sweep runs from the cron trigger through the maintenance queue
 * (`src/server/queues/consumers.ts`); both call `stockService.sweepExpired`.
 *
 * Safe to repeat: a batch is written off only while its quantity is above zero, so a second
 * run finds nothing and writes nothing. Every write-off appends one `expired` row to the
 * item's stock ledger, with no `performedBy` — that is what marks it as automatic.
 *
 * There is no dry run: the sweep writes as it finds, per item. The admin dashboard's
 * "expired" count is the preview.
 *
 *   npx tsx scripts/inventory-expiry-sweep.ts
 */
import './load-dotenv';

import { loadEnv } from '../src/server/config/env';
import { connectToDatabase, disconnectFromDatabase } from '../src/server/db/connection';
import * as organizationRepository from '../src/server/repositories/organization.repository';
import { stockService } from '../src/server/services/stock.service';

async function main(): Promise<void> {
  loadEnv();

  await connectToDatabase();

  // One organization per deployment, resolved here rather than taken from an argument — the
  // same rule the queue consumer follows. The sweep is scoped to it by the repository query.
  const organization = await organizationRepository.getPrimary();
  if (!organization) {
    console.log('No organization has been set up; nothing to sweep.');
    await disconnectFromDatabase();
    return;
  }

  const written = await stockService.sweepExpired(organization.id);
  console.log(`Expired stock written off: ${written.length} item(s)`);
  for (const row of written) {
    console.log(`  - ${row.itemCode} ${row.itemName}: -${row.quantity} ${row.unit} (batches ${row.batchNumber})`);
  }

  await disconnectFromDatabase();
}

main().catch(async (error: unknown) => {
  console.error('✗ Inventory expiry sweep failed');
  console.error(error instanceof Error ? error.message : error);
  await disconnectFromDatabase().catch(() => undefined);
  process.exit(1);
});
