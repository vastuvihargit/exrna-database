/**
 * Request metadata passed from the HTTP boundary into the framework-free service layer.
 *
 * Services need the client IP, user agent and request id for audit rows, but must not
 * know about NextRequest — that is what keeps the backend liftable into NestJS.
 */
export interface RequestMeta {
  requestId: string;
  ip: string;
  userAgent: string;
  origin?: string | null;
}
