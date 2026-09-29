/**
 * Organization repository — a façade over the MongoDB and D1 implementations.
 *
 * Routed by `DATA_SOURCE_ORGANIZATIONS`. Nothing else can move to D1 before this does: every
 * other table's `organization_id` is a foreign key to `organizations.id`, so a D1 write of any
 * kind fails until the tenant row is present there.
 */
import { isD1 } from './data-source';
import { mongoOrganizationRepository } from './organization.repository.mongo';
import { d1OrganizationRepository } from './organization.repository.d1';
import type {
  OrganizationRecord,
  OrganizationRepository,
  OrganizationSettings,
} from './organization.repository.contract';

export type { OrganizationRecord, OrganizationRepository, OrganizationSettings };
export { normalizeSettings } from './organization.repository.contract';
export { mongoOrganizationRepository, d1OrganizationRepository };

function active(): OrganizationRepository {
  return isD1('organizations') ? d1OrganizationRepository : mongoOrganizationRepository;
}

export function getPrimary(): Promise<OrganizationRecord | null> {
  return active().getPrimary();
}

export function findById(id: string): Promise<OrganizationRecord | null> {
  return active().findById(id);
}

/**
 * Domains configured in the database, falling back to the environment allow-list.
 *
 * Engine-independent, so it lives on the façade rather than in either implementation: it is a
 * policy — "the database wins if it has an answer" — not a query.
 */
export async function getSignInDomains(fallback: readonly string[]): Promise<string[]> {
  const org = await getPrimary();
  const fromDb = org?.emailDomains?.filter(Boolean) ?? [];
  return fromDb.length > 0 ? fromDb : [...fallback];
}
