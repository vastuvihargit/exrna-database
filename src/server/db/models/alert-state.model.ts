/**
 * One row per alert key, recording when it was last sent.
 *
 * The monitor runs from cron, so it is a *new process* every time — an in-memory
 * cooldown would forget everything between runs and re-send the same "disk is filling
 * up" every five minutes until somebody muted the channel. Muted alerting is worse than
 * no alerting, because it looks like it is working.
 *
 * Deliberately not an audit record: this is scheduling state, it is overwritten in
 * place, and losing the whole collection costs one duplicate alert.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

const alertStateSchema = new Schema(
  {
    /** Stable identity of the condition, e.g. `disk` or `backup`. */
    key: { type: String, required: true, trim: true, maxlength: 120 },
    /** Severity at the moment it was last sent — an escalation re-alerts immediately. */
    severity: { type: String, enum: ['warning', 'critical'], required: true },
    lastSentAt: { type: Date, required: true },
    /** How many times this condition has been observed since it first fired. */
    occurrences: { type: Number, required: true, default: 1, min: 1 },
    lastDetail: { type: String, default: '', maxlength: 1000 },
    /** Set when the condition clears, so a recovery notice is sent exactly once. */
    resolvedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    strict: 'throw',
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = String(ret._id);
        delete ret._id;
        return ret;
      },
    },
  },
);

alertStateSchema.index({ key: 1 }, { unique: true });

export type AlertStateDocument = InferSchemaType<typeof alertStateSchema>;

export const AlertStateModel: Model<AlertStateDocument> =
  (models.AlertState as Model<AlertStateDocument>) ??
  model<AlertStateDocument>('AlertState', alertStateSchema);
