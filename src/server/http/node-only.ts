/**
 * Routes that exist on the Node deployment only, and answer a Worker with a controlled 501.
 *
 * Three administrative tools are Node-only by design, not by omission:
 *
 *   • `/api/admin/migrations/**`          the Personal-Drive import — Mongo job tables, and a
 *                                         worker loop that runs for hours;
 *   • `/api/admin/storage-migration/**`   the local-disk → Shared Drive storage migration —
 *                                         reads the server's own disk by definition;
 *   • `/api/admin/storage/local-copies`   the retained local copies that migration left behind.
 *
 * Each exists to move data *off* the Node deployment. On a Worker there is no local disk and no
 * MongoDB, so there is nothing for them to move, and porting them would build a tool whose only
 * input does not exist. Their modules are still in the Worker bundle (the Next build has one
 * module graph), so without a guard the first call would reach Mongoose or `node:fs` and fail
 * as a 500 that looks like a bug.
 *
 * The guard runs *after* authentication: an anonymous caller learns nothing from this route
 * that it could not learn from any other (401), and a signed-in administrator is told plainly
 * that the tool belongs to the other deployment.
 */
import type { NextRequest } from 'next/server';

import { AppError } from '@/server/errors/app-error';
import { isWorkerRuntime } from '@/server/runtime';
import { withAuthenticatedRoute, type AuthenticatedContext } from './authenticated-route';

export class NodeOnlyOperationError extends AppError {
  readonly feature: string;

  constructor(feature: string) {
    super(
      'NODE_ONLY_OPERATION',
      `${feature} runs on the legacy Node deployment only and is not available on this deployment.`,
      501,
    );
    this.feature = feature;
  }
}

/** Throws `NodeOnlyOperationError` on a Worker; does nothing on Node. */
export function assertNodeOnlyOperation(feature: string): void {
  if (isWorkerRuntime()) throw new NodeOnlyOperationError(feature);
}

/**
 * Wraps an authenticated handler so that on a Worker it answers 501 before the handler — and
 * therefore before any service, model or filesystem call — runs.
 *
 *   export const GET = withAuthenticatedRoute(nodeOnly('Drive import', async (request, ctx) => …));
 */
export function nodeOnly<TParams>(
  feature: string,
  handler: (request: NextRequest, context: AuthenticatedContext<TParams>) => Promise<Response> | Response,
): (request: NextRequest, context: AuthenticatedContext<TParams>) => Promise<Response> | Response {
  return (request, context) => {
    assertNodeOnlyOperation(feature);
    return handler(request, context);
  };
}

/** The labels the admin UI and the routes share, so the 501 names the tool the page named. */
export const NODE_ONLY_FEATURES = {
  driveImport: 'Import from Google Drive',
  storageMigration: 'The local storage → Shared Drive migration',
  localCopies: 'Retained local copies',
} as const;

/**
 * `withAuthenticatedRoute`, for a Node-only tool: authentication first (401 stays 401), then a
 * 501 on a Worker, then the handler.
 */
export function withNodeOnlyRoute<TParams = Record<string, string>>(
  feature: string,
  handler: (request: NextRequest, context: AuthenticatedContext<TParams>) => Promise<Response> | Response,
) {
  return withAuthenticatedRoute<TParams>(nodeOnly(feature, handler));
}
