/**
 * MongoDB index review.
 *
 * Indexes rot in two directions and both cost real money:
 *
 *   • **Missing** — a query that was fast in development does a collection scan in
 *     production. The symptom is "the app got slow", which is a hard thing to trace back
 *     to a `syncIndexes()` that never ran during a deploy.
 *
 *   • **Unused or redundant** — every index is paid for on every write and in RAM. An
 *     index on `{a: 1}` when `{a: 1, b: 1}` already exists is pure overhead, because the
 *     compound index already serves any query the single-field one would.
 *
 * This reports both, plus `$indexStats` usage counters so an index nobody has queried
 * since the last restart is visible rather than assumed necessary.
 *
 *   npm run review:indexes
 *   npm run review:indexes -- --json     # machine-readable, for CI
 *
 * Exit codes:
 *   0  declared and live indexes agree
 *   1  the review could not run
 *   2  a declared index is missing from the database — deploy `syncAllIndexes()`
 *
 * Redundant and unused indexes are reported but never cause a non-zero exit: dropping
 * an index is a judgement call about traffic this script cannot see (a nightly report
 * that runs once a month will look "unused" all day).
 */
import './load-dotenv';

interface IndexSummary {
  name: string;
  key: Record<string, number | string>;
  /** Comparable form — text indexes are normalised, see `signature`. */
  signature: string;
  unique: boolean;
  partial: boolean;
  text: boolean;
  ops?: number;
}

interface CollectionReport {
  collection: string;
  documents: number;
  storageBytes: number;
  indexBytes: number;
  live: IndexSummary[];
  missing: string[];
  undeclared: string[];
  redundant: Array<{ index: string; coveredBy: string }>;
  unused: string[];
}

async function main(): Promise<number> {
  const asJson = process.argv.includes('--json');

  const { connectToDatabase, disconnectFromDatabase } = await import('../src/server/db/connection');
  const { registeredModels } = await import('../src/server/db/models');

  await connectToDatabase();

  const reports: CollectionReport[] = [];

  try {
    for (const model of registeredModels) {
      const collection = model.collection;

      // What the schema says should exist. `schema.indexes()` returns explicit index()
      // declarations plus field-level `index: true` / `unique: true`.
      const declared = model.schema.indexes().map(([key, options]) => ({
        key: key as Record<string, number | string>,
        signature: signature(key as Record<string, number | string>),
        options: (options ?? {}) as Record<string, unknown>,
      }));

      let liveRaw: Array<Record<string, unknown>> = [];
      try {
        liveRaw = (await collection.indexes()) as Array<Record<string, unknown>>;
      } catch {
        // Collection does not exist yet — nothing has been written to it. Not an error:
        // MongoDB creates collections lazily and a fresh deployment is full of these.
        reports.push({
          collection: collection.collectionName,
          documents: 0,
          storageBytes: 0,
          indexBytes: 0,
          live: [],
          missing: declared.map((entry) => entry.signature),
          undeclared: [],
          redundant: [],
          unused: [],
        });
        continue;
      }

      const usage = await indexUsage(collection);

      const live: IndexSummary[] = liveRaw.map((index) => {
        const key = index.key as Record<string, number | string>;
        const name = String(index.name);
        const ops = usage.get(name);
        return {
          name,
          key,
          signature: signature(key, index.weights as Record<string, number> | undefined),
          unique: index.unique === true,
          partial: index.partialFilterExpression !== undefined,
          text: index.weights !== undefined,
          ...(ops !== undefined ? { ops } : {}),
        };
      });

      const liveSignatures = new Set(live.map((index) => index.signature));
      const declaredSignatures = new Set(declared.map((entry) => entry.signature));

      const missing = declared
        .filter((entry) => !liveSignatures.has(entry.signature))
        .map((entry) => entry.signature);

      const undeclared = live
        // `_id_` is created by MongoDB itself and is never declared in a schema.
        .filter((index) => index.name !== '_id_' && !declaredSignatures.has(index.signature))
        .map((index) => `${index.name} {${index.signature}}`);

      const stats = await collectionStats(collection);

      reports.push({
        collection: collection.collectionName,
        documents: stats.count,
        storageBytes: stats.size,
        indexBytes: stats.indexSize,
        live,
        missing,
        undeclared,
        redundant: findRedundant(live),
        unused: live
          .filter((index) => index.name !== '_id_' && index.ops === 0)
          .map((index) => index.name),
      });
    }
  } finally {
    await disconnectFromDatabase().catch(() => undefined);
  }

  if (asJson) {
    console.log(JSON.stringify({ reports }, null, 2));
  } else {
    print(reports);
  }

  return reports.some((report) => report.missing.length > 0) ? 2 : 0;
}

/**
 * A stable textual form of an index key, so `{a:1,b:-1}` compares reliably.
 *
 * Text indexes are the awkward case: a schema declares `{name: 'text', email: 'text'}`
 * but MongoDB stores it as `{_fts: 'text', _ftsx: 1}` with the real field list moved
 * into `weights`. Comparing raw keys would report every text index as missing — a
 * false alarm on five collections, which is how a check earns the right to be ignored.
 */
function signature(
  key: Record<string, number | string>,
  weights?: Record<string, number>,
): string {
  const textFields = weights
    ? Object.keys(weights)
    : Object.entries(key)
        .filter(([, direction]) => direction === 'text')
        .map(([field]) => field);

  if (textFields.length > 0) {
    const rest = Object.entries(key)
      .filter(([field, direction]) => direction !== 'text' && field !== '_fts' && field !== '_ftsx')
      .map(([field, direction]) => `${field}:${direction}`);
    return [`text(${[...textFields].sort().join(',')})`, ...rest].join(',');
  }

  return Object.entries(key)
    .map(([field, direction]) => `${field}:${direction}`)
    .join(',');
}

/**
 * Finds indexes whose key is a strict prefix of another index's key.
 *
 * MongoDB can use `{a:1,b:1}` for any query that only filters on `a`, so the standalone
 * `{a:1}` earns nothing and costs a write amplification on every insert. Uniqueness and
 * partial filters change the semantics, so those are never reported as redundant even
 * when the keys line up — dropping a unique index is not a performance tweak.
 */
function findRedundant(indexes: readonly IndexSummary[]): Array<{ index: string; coveredBy: string }> {
  const redundant: Array<{ index: string; coveredBy: string }> = [];

  for (const candidate of indexes) {
    // Text indexes are excluded from both sides: their stored key is `_fts/_ftsx`, which
    // is not a prefix relationship with anything meaningful.
    if (candidate.name === '_id_' || candidate.unique || candidate.partial || candidate.text) {
      continue;
    }
    const candidateFields = Object.keys(candidate.key);

    for (const other of indexes) {
      if (other.name === candidate.name || other.partial || other.text) continue;
      const otherFields = Object.keys(other.key);
      if (otherFields.length <= candidateFields.length) continue;

      const isPrefix = candidateFields.every(
        (field, position) =>
          otherFields[position] === field && other.key[field] === candidate.key[field],
      );

      if (isPrefix) {
        redundant.push({ index: candidate.name, coveredBy: other.name });
        break;
      }
    }
  }

  return redundant;
}

/** Per-index operation counters since the server last started. Optional: needs privileges. */
async function indexUsage(
  collection: { aggregate: (pipeline: object[]) => { toArray: () => Promise<unknown[]> } },
): Promise<Map<string, number>> {
  const usage = new Map<string, number>();
  try {
    const rows = (await collection.aggregate([{ $indexStats: {} }]).toArray()) as Array<{
      name?: string;
      accesses?: { ops?: number | { toString(): string } };
    }>;
    for (const row of rows) {
      if (!row.name) continue;
      usage.set(row.name, Number(row.accesses?.ops ?? 0));
    }
  } catch {
    // $indexStats is unavailable on some managed tiers and needs clusterMonitor on
    // others. Usage counts are a nice-to-have; the missing/redundant analysis is not.
  }
  return usage;
}

async function collectionStats(collection: {
  countDocuments: () => Promise<number>;
  aggregate: (pipeline: object[]) => { toArray: () => Promise<unknown[]> };
}): Promise<{ count: number; size: number; indexSize: number }> {
  try {
    const rows = (await collection
      .aggregate([{ $collStats: { storageStats: {} } }])
      .toArray()) as Array<{ storageStats?: { size?: number; totalIndexSize?: number } }>;
    const stats = rows[0]?.storageStats;
    return {
      count: await collection.countDocuments(),
      size: stats?.size ?? 0,
      indexSize: stats?.totalIndexSize ?? 0,
    };
  } catch {
    return { count: await collection.countDocuments().catch(() => 0), size: 0, indexSize: 0 };
  }
}

function print(reports: readonly CollectionReport[]): void {
  console.log('MongoDB index review');
  console.log('═'.repeat(78));

  let totalIndexBytes = 0;
  let problems = 0;

  for (const report of reports) {
    totalIndexBytes += report.indexBytes;
    const hasNotes =
      report.missing.length > 0 ||
      report.undeclared.length > 0 ||
      report.redundant.length > 0 ||
      report.unused.length > 0;

    console.log(
      `\n${report.collection}  —  ${report.documents.toLocaleString('en-GB')} docs · ` +
        `${mb(report.storageBytes)} data · ${mb(report.indexBytes)} indexes · ${report.live.length} indexes`,
    );

    if (!hasNotes) {
      console.log('  ✓ declared and live indexes agree');
      continue;
    }

    for (const missing of report.missing) {
      problems += 1;
      console.log(`  ✗ MISSING   {${missing}} — declared in the schema but not built`);
    }
    for (const undeclared of report.undeclared) {
      console.log(`  ! EXTRA     ${undeclared} — in the database but not in the schema`);
    }
    for (const entry of report.redundant) {
      console.log(`  ! REDUNDANT ${entry.index} — its key is a prefix of ${entry.coveredBy}`);
    }
    for (const unused of report.unused) {
      console.log(`  · UNUSED    ${unused} — zero operations since the server last started`);
    }
  }

  console.log(`\n${'═'.repeat(78)}`);
  console.log(`Total index footprint: ${mb(totalIndexBytes)}`);

  if (problems > 0) {
    console.log(`\n✗ ${problems} declared index(es) missing. Run the deploy's syncAllIndexes().`);
  } else {
    console.log('\n✓ Every declared index exists.');
  }
  console.log(
    'Note: "unused" counts reset when mongod restarts, and a monthly report will look ' +
      'unused for 29 days. Confirm before dropping anything.',
  );
}

function mb(bytes: number): string {
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('✗ Index review failed');
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
