/**
 * What each Worker cron trigger enqueues.
 *
 * The triggers are declared in `wrangler.jsonc`; this pins the mapping from trigger to work, and
 * that the two lists agree — a cron expression in the config that the code does not recognise
 * would fire every hour and do nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DAILY_HOUR_UTC,
  DRIVE_SYNC_CRON,
  MAINTENANCE_CRON,
  scheduledMessages,
} from '@/server/queues/schedule';
import { syncQueueMessageSchema } from '@/server/queues/messages';

describe('scheduled work', () => {
  it('the 15-minute trigger enqueues exactly one Drive sync', () => {
    const messages = scheduledMessages(DRIVE_SYNC_CRON, new Date('2026-09-27T10:15:00Z'));
    expect(messages).toEqual([
      { kind: 'drive.sync', trigger: 'cron', requestedAt: '2026-09-27T10:15:00.000Z' },
    ]);
  });

  it('the hourly trigger enqueues the upload cleanup and the approval check', () => {
    const messages = scheduledMessages(MAINTENANCE_CRON, new Date('2026-09-27T10:07:00Z'));
    expect(messages.map((m) => (m.kind === 'maintenance.run' ? m.job : m.kind))).toEqual([
      'uploads.cleanup',
      'approvals.check',
    ]);
  });

  it('once a day it also purges trash and sweeps expired inventory', () => {
    const at = new Date(Date.UTC(2026, 8, 27, DAILY_HOUR_UTC, 7));
    const jobs = scheduledMessages(MAINTENANCE_CRON, at).map((m) => (m.kind === 'maintenance.run' ? m.job : m.kind));
    expect(jobs).toEqual(['uploads.cleanup', 'approvals.check', 'trash.purge', 'inventory.expire']);
  });

  it('an unknown trigger enqueues nothing', () => {
    expect(scheduledMessages('0 0 1 1 *', new Date())).toEqual([]);
  });

  it('every message it produces is one the consumer accepts', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const at = new Date(Date.UTC(2026, 8, 27, hour, 7));
      for (const cron of [DRIVE_SYNC_CRON, MAINTENANCE_CRON]) {
        for (const message of scheduledMessages(cron, at)) {
          expect(syncQueueMessageSchema.safeParse(message).success).toBe(true);
        }
      }
    }
  });

  it('every environment in wrangler.jsonc declares exactly the triggers the code handles', () => {
    const config = fs.readFileSync(path.resolve(__dirname, '../../wrangler.jsonc'), 'utf8');
    const declared = [...config.matchAll(/"crons":\s*\[([^\]]*)\]/g)].map((match) =>
      [...match[1]!.matchAll(/"([^"]+)"/g)].map((cron) => cron[1]),
    );
    expect(declared).toHaveLength(4); // top level + development, staging, production
    for (const crons of declared) expect(crons).toEqual([DRIVE_SYNC_CRON, MAINTENANCE_CRON]);
  });
});
