/**
 * Runtime settings — the shape both engines implement.
 *
 * A small key/value store scoped to an organization, holding things an administrator can change
 * without a redeploy.
 *
 * ── `value` is JSON, and it is trusted on read ──────────────────────────────────────────
 *
 * MongoDB stored it in a `Mixed` field; D1 stores `JSON.stringify` output in a TEXT column.
 * Either way, whatever comes back out is handed to whichever consumer owns that key and used as
 * a configuration value.
 *
 * That makes the *write* the security boundary, and the original comment on this repository said
 * so: `value` is always something this codebase constructed, never a request body threaded
 * through. An attacker-shaped object stored here is read back and trusted.
 *
 * The read side has one extra rule that D1 forces into the open: a value that does not parse
 * cannot be distinguished from a value that is legitimately the string `"{"`. `get` returns the
 * record with `value: null` and logs, rather than throwing — a corrupt setting must degrade the
 * one feature that reads it, not take down whatever page happened to ask.
 */

export interface AppSettingRecord {
  key: string;
  value: unknown;
  description: string;
  updatedBy: string | null;
  updatedAt: Date;
}

export interface PutAppSettingInput {
  organizationId: string;
  key: string;
  value: unknown;
  description?: string;
  updatedBy: string;
}

export interface AppSettingRepository {
  get(organizationId: string, key: string): Promise<AppSettingRecord | null>;
  getMany(organizationId: string, keys: string[]): Promise<Map<string, AppSettingRecord>>;
  /** Upsert. Creates the row if absent, and leaves `description` alone when not supplied. */
  put(input: PutAppSettingInput): Promise<AppSettingRecord>;
  remove(organizationId: string, key: string): Promise<boolean>;
}
