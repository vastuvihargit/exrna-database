import { Types } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { OrganizationModel, type OrganizationDocument } from '@/server/db/models';

export interface OrganizationRecord {
  id: string;
  name: string;
  slug: string;
  emailDomains: string[];
  settings: {
    allowAutoProvisioning: boolean;
    defaultUserQuotaBytes: number;
    defaultDepartmentQuotaBytes: number;
    maxUploadBytes: number;
    allowedExtensions: string[];
    blockedExtensions: string[];
    trashRetentionDays: number;
    requireApprovalForCategories: string[];
    allowSelfApproval: boolean;
  };
  storageUsedBytes: number;
  isActive: boolean;
}

type LeanOrg = OrganizationDocument & { _id: Types.ObjectId };

function toRecord(doc: LeanOrg): OrganizationRecord {
  return {
    id: String(doc._id),
    name: doc.name,
    slug: doc.slug,
    emailDomains: doc.emailDomains ?? [],
    settings: {
      allowAutoProvisioning: Boolean(doc.settings?.allowAutoProvisioning),
      defaultUserQuotaBytes: doc.settings?.defaultUserQuotaBytes ?? 0,
      defaultDepartmentQuotaBytes: doc.settings?.defaultDepartmentQuotaBytes ?? 0,
      maxUploadBytes: doc.settings?.maxUploadBytes ?? 0,
      allowedExtensions: doc.settings?.allowedExtensions ?? [],
      blockedExtensions: doc.settings?.blockedExtensions ?? [],
      trashRetentionDays: doc.settings?.trashRetentionDays ?? 30,
      requireApprovalForCategories: doc.settings?.requireApprovalForCategories ?? [],
      allowSelfApproval: Boolean(doc.settings?.allowSelfApproval),
    },
    storageUsedBytes: doc.storageUsedBytes ?? 0,
    isActive: Boolean(doc.isActive),
  };
}

/**
 * The MVP is single-tenant (assumption A1): there is exactly one organization and it is
 * created by the seed script. Returning "the first active one" keeps call sites simple
 * while every document still carries organizationId for a future multi-tenant split.
 */
export async function getPrimary(): Promise<OrganizationRecord | null> {
  await connectToDatabase();
  const doc = await OrganizationModel.findOne({ isActive: true })
    .sort({ createdAt: 1 })
    .lean<LeanOrg>()
    .exec();
  return doc ? toRecord(doc) : null;
}

export async function findById(id: string): Promise<OrganizationRecord | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  await connectToDatabase();
  const doc = await OrganizationModel.findOne({ _id: new Types.ObjectId(id) }).lean<LeanOrg>().exec();
  return doc ? toRecord(doc) : null;
}

/** Domains configured in the database, falling back to the environment allow-list. */
export async function getSignInDomains(fallback: readonly string[]): Promise<string[]> {
  const org = await getPrimary();
  const fromDb = org?.emailDomains?.filter(Boolean) ?? [];
  return fromDb.length > 0 ? fromDb : [...fallback];
}
