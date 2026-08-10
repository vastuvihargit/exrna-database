/**
 * The MongoDB organization repository — the existing implementation, moved behind the contract.
 *
 * The only change is that settings normalisation is now `normalizeSettings` from the contract
 * rather than an inline field-by-field copy, so both engines choose the same defaults.
 */
import { Types } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { OrganizationModel, type OrganizationDocument } from '@/server/db/models';
import {
  normalizeSettings,
  type OrganizationRecord,
  type OrganizationRepository,
} from './organization.repository.contract';

type LeanOrg = OrganizationDocument & { _id: Types.ObjectId };

function toRecord(doc: LeanOrg): OrganizationRecord {
  return {
    id: String(doc._id),
    name: doc.name,
    slug: doc.slug,
    emailDomains: doc.emailDomains ?? [],
    settings: normalizeSettings(doc.settings),
    storageUsedBytes: doc.storageUsedBytes ?? 0,
    isActive: Boolean(doc.isActive),
  };
}

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
  const doc = await OrganizationModel.findOne({ _id: new Types.ObjectId(id) })
    .lean<LeanOrg>()
    .exec();
  return doc ? toRecord(doc) : null;
}

export const mongoOrganizationRepository: OrganizationRepository = {
  getPrimary,
  findById,
};
