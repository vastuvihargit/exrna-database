/**
 * Route handler wrapper.
 *
 * Every /api route is wrapped so that request-id propagation, structured logging and
 * error mapping are automatic rather than remembered. A handler that throws can never
 * leak a stack trace or an internal message to the client.
 */
import type { NextRequest } from 'next/server';
import { requestLogger } from '@/server/logging/logger';
import { toErrorResponse } from './api-response';
import { assertRequestAllowed } from '@/server/runtime/maintenance';

export interface RequestContext {
  requestId: string;
  /** Client IP as seen through the reverse proxy; used for audit rows and rate limits. */
  ip: string;
  userAgent: string;
  method: string;
  path: string;
}

const REQUEST_ID_HEADER = 'x-request-id';

export function buildRequestContext(request: NextRequest): RequestContext {
  const headerId = request.headers.get(REQUEST_ID_HEADER);
  // Only accept an upstream id that looks like one — it ends up in audit logs.
  const requestId =
    headerId && /^[A-Za-z0-9-]{8,64}$/.test(headerId) ? headerId : crypto.randomUUID();

  // The address the per-IP sign-in limit counts against, so only headers a proxy *overwrites*
  // come first: Cloudflare sets CF-Connecting-IP, and the Node deployment's nginx sets X-Real-IP
  // to $remote_addr. X-Forwarded-For is appended to by both, so its first entry is whatever the
  // client wrote — keyed on that, anyone could reset their own counter with a header. It remains
  // only as the last resort for a server with no proxy in front (`next dev`).
  const forwardedFor = request.headers.get('x-forwarded-for');
  const ip =
    request.headers.get('cf-connecting-ip')?.trim() ||
    request.headers.get('x-real-ip')?.trim() ||
    forwardedFor?.split(',')[0]?.trim() ||
    'unknown';

  return {
    requestId,
    ip,
    userAgent: request.headers.get('user-agent') ?? 'unknown',
    method: request.method,
    path: new URL(request.url).pathname,
  };
}

type Handler<TParams> = (
  request: NextRequest,
  context: { params: TParams; requestContext: RequestContext },
) => Promise<Response> | Response;

export function withRouteHandler<TParams = Record<string, string>>(handler: Handler<TParams>) {
  return async (
    request: NextRequest,
    routeContext: { params: Promise<TParams> } | undefined,
  ): Promise<Response> => {
    const requestContext = buildRequestContext(request);
    const log = requestLogger(requestContext.requestId, {
      method: requestContext.method,
      path: requestContext.path,
    });
    const startedAt = Date.now();

    try {
      // Maintenance and write-freeze modes are enforced here, in front of every API route, so
      // no route can forget them.
      assertRequestAllowed(requestContext.method, requestContext.path);
      const params = ((await routeContext?.params) ?? {}) as TParams;
      const response = await handler(request, { params, requestContext });
      // Make the id available to the client for support requests, always.
      if (!response.headers.has('X-Request-Id')) {
        response.headers.set('X-Request-Id', requestContext.requestId);
      }
      log.debug({ status: response.status, durationMs: Date.now() - startedAt }, 'request completed');
      return response;
    } catch (error) {
      log.debug({ durationMs: Date.now() - startedAt }, 'request failed');
      return toErrorResponse(error, requestContext.requestId);
    }
  };
}
