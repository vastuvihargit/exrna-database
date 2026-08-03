/**
 * Key/value application settings that admins can change at runtime
 * (upload limits, allowed file types, retention windows, feature flags).
 *
 * Values that gate security decisions are read here first and fall back to the
 * validated environment — the environment is the floor, settings can only be
 * as permissive as the deployment allows.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from '@/server/db/base-schema';

const appSettingSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    key: { type: String, required: true, trim: true, maxlength: 120 },
    value: { type: Schema.Types.Mixed, required: true },
    description: { type: String, default: '' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  baseSchemaOptions,
);

appSettingSchema.index({ organizationId: 1, key: 1 }, { unique: true });

export type AppSettingDocument = InferSchemaType<typeof appSettingSchema>;

export const AppSettingModel: Model<AppSettingDocument> =
  (models.AppSetting as Model<AppSettingDocument>) ??
  model<AppSettingDocument>('AppSetting', appSettingSchema);
