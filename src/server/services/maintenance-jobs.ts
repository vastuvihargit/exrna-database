/**
 * The scheduled maintenance job names, on their own so the queue message schema can name them
 * without importing every service the jobs run. See `maintenance.service.ts`.
 */
export const MAINTENANCE_JOBS = [
  'uploads.cleanup',
  'approvals.check',
  'trash.purge',
  'inventory.expire',
] as const;

export type MaintenanceJob = (typeof MAINTENANCE_JOBS)[number];
