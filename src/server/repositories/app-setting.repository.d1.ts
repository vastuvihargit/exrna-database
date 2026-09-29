/**
 * The D1 app-setting repository.
 *
 * ── The upsert is one statement, not read-then-write ────────────────────────────────────
 *
 * `ux_app_settings_org_key` makes `(organization_id, key)` unique, and `put` is
 * `INSERT … ON CONFLICT DO UPDATE`. Two administrators saving the same setting at once therefore
 * produce one row and a last-writer-wins value, which is what Mongo's `upsert: true` did. A
 * `SELECT` followed by an `INSERT` or `UPDATE` would instead give one of them a unique-constraint
 * 500 for an action that had already succeeded.
 *
 * ── `description` is only overwritten when supplied ─────────────────────────────────────
 *
 * Mongo built its `$set` conditionally. The D1 equivalent is `COALESCE(excluded.description,
 * app_settings.description)` — spelled out rather than achieved by omitting the column, because
 * `ON CONFLICT DO UPDATE SET` with a column absent leaves it alone only by accident of which
 * columns the statement happens to list, and that is a property nobody will notice breaking.
 *
 * ── A value that does not parse ─────────────────────────────────────────────────────────
 *
 * Returned as `null` with a log line, never thrown. See the contract: a corrupt setting should
 * degrade the one feature that reads it rather than fail whichever page asked.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getD1 } from '@/server/db/d1-context';
import { inList } from '@/server/db/d1-bindings';
import { appSettings } from '@/server/db/schema/identity';
import { getLogger } from '@/server/logging/logger';
import type {
  AppSettingRecord,
  AppSettingRepository,
  PutAppSettingInput,
} from './app-setting.repository.contract';

interface SettingRow {
  key: string;
  value: string;
  description: string;
  updatedBy: string | null;
  updatedAt: string;
}

const recordColumns = {
  key: appSettings.key,
  value: appSettings.value,
  description: appSettings.description,
  updatedBy: appSettings.updatedBy,
  updatedAt: appSettings.updatedAt,
} as const;

function parseValue(raw: string, key: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    getLogger().error({ key }, 'An application setting does not hold valid JSON; treating as unset');
    return null;
  }
}

function toRecord(row: SettingRow): AppSettingRecord {
  return {
    key: row.key,
    value: parseValue(row.value, row.key),
    description: row.description ?? '',
    updatedBy: row.updatedBy,
    updatedAt: new Date(row.updatedAt),
  };
}

export async function get(organizationId: string, key: string): Promise<AppSettingRecord | null> {
  const db = await getD1();
  const [row] = await db
    .select(recordColumns)
    .from(appSettings)
    .where(and(eq(appSettings.organizationId, organizationId), eq(appSettings.key, key)))
    .limit(1);

  return row ? toRecord(row as SettingRow) : null;
}

export async function getMany(
  organizationId: string,
  keys: string[],
): Promise<Map<string, AppSettingRecord>> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return new Map();

  const db = await getD1();
  // `inList`, not `inArray`: a settings page reads every key it knows about in one call, and D1
  // caps a statement at 100 bound parameters. See `d1-bindings.ts`.
  const rows = await db
    .select(recordColumns)
    .from(appSettings)
    .where(and(eq(appSettings.organizationId, organizationId), inList(appSettings.key, unique)));

  return new Map(rows.map((row) => [row.key, toRecord(row as SettingRow)]));
}

export async function put(input: PutAppSettingInput): Promise<AppSettingRecord> {
  const db = await getD1();
  const now = new Date().toISOString();
  const serialized = JSON.stringify(input.value ?? null);

  const [row] = await db
    .insert(appSettings)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      key: input.key,
      value: serialized,
      description: input.description ?? '',
      updatedBy: input.updatedBy,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [appSettings.organizationId, appSettings.key],
      set: {
        value: serialized,
        updatedBy: input.updatedBy,
        updatedAt: now,
        // Absent description keeps whatever the row already had — see the header.
        description:
          input.description !== undefined
            ? input.description
            : sql`${appSettings.description}`,
      },
    })
    .returning(recordColumns);

  return toRecord(row as SettingRow);
}

export async function remove(organizationId: string, key: string): Promise<boolean> {
  const db = await getD1();
  const result = await db
    .delete(appSettings)
    .where(and(eq(appSettings.organizationId, organizationId), eq(appSettings.key, key)));

  return ((result as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;
}

export const d1AppSettingRepository: AppSettingRepository = {
  get,
  getMany,
  put,
  remove,
};
