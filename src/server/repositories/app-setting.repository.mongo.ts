/**
 * The MongoDB app-setting repository — the existing implementation, moved behind the contract.
 *
 * The unused `ClientSession` parameter on `put` is dropped: no caller passed one.
 */
import { Types } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { AppSettingModel, type AppSettingDocument } from '@/server/db/models';
import type {
  AppSettingRecord,
  AppSettingRepository,
  PutAppSettingInput,
} from './app-setting.repository.contract';

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
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

export async function get(organizationId: string, key: string): Promise<AppSettingRecord | null> {
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
  if (keys.length === 0) return new Map();
  await connectToDatabase();
  const docs = await AppSettingModel.find({
    organizationId: oid(organizationId),
    key: { $in: keys },
  })
    .lean<LeanSetting[]>()
    .exec();
  return new Map(docs.map((doc) => [doc.key, toRecord(doc)]));
}

export async function put(input: PutAppSettingInput): Promise<AppSettingRecord> {
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
    { new: true, upsert: true },
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

export const mongoAppSettingRepository: AppSettingRepository = {
  get,
  getMany,
  put,
  remove,
};
