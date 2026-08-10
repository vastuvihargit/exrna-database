/**
 * Organizations — the shape both engines implement.
 *
 * The MVP is single-tenant (assumption A1): there is exactly one organization, created by the
 * seed script. Every other record still carries an `organizationId`, so the split to real
 * multi-tenancy is a change to what this repository returns rather than a change to the schema.
 *
 * ── `settings` is normalised here, in one place ─────────────────────────────────────────
 *
 * MongoDB stored settings as a sub-document with defaults applied by Mongoose; D1 stores the
 * same object as a single JSON column, because it is read whole by `getPrimary()` and never
 * filtered on. Neither engine can be trusted to have every key present — a document written
 * before an option existed simply lacks it — so `normalizeSettings` below is shared by both
 * implementations and is the only place a default is chosen.
 *
 * Duplicating that per engine is how the two databases come to disagree about whether
 * self-approval is allowed, which is an authorization difference dressed as a config default.
 */

export interface OrganizationSettings {
  allowAutoProvisioning: boolean;
  defaultUserQuotaBytes: number;
  defaultDepartmentQuotaBytes: number;
  maxUploadBytes: number;
  allowedExtensions: string[];
  blockedExtensions: string[];
  trashRetentionDays: number;
  requireApprovalForCategories: string[];
  allowSelfApproval: boolean;
}

export interface OrganizationRecord {
  id: string;
  name: string;
  slug: string;
  emailDomains: string[];
  settings: OrganizationSettings;
  storageUsedBytes: number;
  isActive: boolean;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * The single default-choosing point for organization settings, shared by both engines.
 *
 * `trashRetentionDays` defaults to 30 rather than 0 because 0 would mean "purge immediately" —
 * a missing key must not be readable as an instruction to delete.
 */
export function normalizeSettings(raw: unknown): OrganizationSettings {
  const value = (raw ?? {}) as Record<string, unknown>;
  return {
    allowAutoProvisioning: Boolean(value.allowAutoProvisioning),
    defaultUserQuotaBytes: numberOr(value.defaultUserQuotaBytes, 0),
    defaultDepartmentQuotaBytes: numberOr(value.defaultDepartmentQuotaBytes, 0),
    maxUploadBytes: numberOr(value.maxUploadBytes, 0),
    allowedExtensions: stringArray(value.allowedExtensions),
    blockedExtensions: stringArray(value.blockedExtensions),
    trashRetentionDays: numberOr(value.trashRetentionDays, 30),
    requireApprovalForCategories: stringArray(value.requireApprovalForCategories),
    allowSelfApproval: Boolean(value.allowSelfApproval),
  };
}

export interface OrganizationRepository {
  /** The single tenant: the oldest active organization. */
  getPrimary(): Promise<OrganizationRecord | null>;
  findById(id: string): Promise<OrganizationRecord | null>;
}
