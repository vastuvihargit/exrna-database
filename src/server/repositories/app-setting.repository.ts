import { Types, type ClientSession } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { AppSettingModel, type AppSettingDocument } from '@/server/db/models';

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

export interface AppSettingRecord {
  key: string;
  value: unknown;
  description: string;
  updatedBy: string | null;
  updatedAt: Date;
}

type LeanSetting = AppSettingDocument & { _id: Types.ObjectId; updatedAt: Date };

function toRecord(doc: LeanSetting): AppSettingRecord {
  return {
    key: doc.key,
    value: doc.value,
    description: doc.description ?? '',
    updatedBy: doc.updatedBy ? String(doc.updatedBy) : null,
    updatedAt: doc.updatedAt,
  };
}

export async function get(
  organizationId: string,
  key: string,
): Promise<AppSettingRecord | null> {
  await connectToDatabase();
  const doc = await AppSettingModel.findOne({ organizationId: oid(organizationId), key })
    .lean<LeanSetting>()
    .exec();
  return doc ? toRecord(doc) : null;
}

export async function getMany(
  organizationId: string,
  keys: string[],
): Promise<Map<string, AppSettingRecord>> {
  await connectToDatabase();
  const docs = await AppSettingModel.find({
    organizationId: oid(organizationId),
    key: { $in: keys },
  })
    .lean<LeanSetting[]>()
    .exec();
  return new Map(docs.map((doc) => [doc.key, toRecord(doc)]));
}

/**
 * Writes a setting.
 *
 * `value` is always a value this codebase constructed — never a request body handed
 * through. Settings live in a Mixed field, so an attacker-shaped object stored here
 * would be read back and trusted by whatever consumes the key.
 */
export async function put(
  input: {
    organizationId: string;
    key: string;
    value: unknown;
    description?: string;
    updatedBy: string;
  },
  session?: ClientSession,
): Promise<AppSettingRecord> {
  await connectToDatabase();
  const doc = await AppSettingModel.findOneAndUpdate(
    { organizationId: oid(input.organizationId), key: input.key },
    {
      $set: {
        value: input.value,
        updatedBy: oid(input.updatedBy),
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
    },
    { new: true, upsert: true, session: session ?? null },
  )
    .lean<LeanSetting>()
    .exec();
  return toRecord(doc);
}

export async function remove(organizationId: string, key: string): Promise<boolean> {
  await connectToDatabase();
  const result = await AppSettingModel.deleteOne({
    organizationId: oid(organizationId),
    key,
  }).exec();
  return result.deletedCount > 0;
}
