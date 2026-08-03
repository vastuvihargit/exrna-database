/**
 * The development-tools gate.
 *
 * One function decides whether developer-only features exist, and everything that could
 * be dangerous asks it. Having a single answer is the point: a switcher that is hidden
 * in the UI but whose API still works is not disabled, it is merely inconvenient to
 * find.
 *
 * The rule has two parts and they are not symmetrical:
 *
 *   • `NODE_ENV === 'production'` disables it unconditionally. There is no environment
 *     variable, header, cookie or query parameter that can turn it back on — see the
 *     boot refusal in `env.ts`, which will not let the process start if a production
 *     configuration even *asks* for it.
 *
 *   • Outside production it is on by default and `ENABLE_DEV_SWITCHER=false` turns it
 *     off — useful for a shared staging box where you want production-like behaviour
 *     without a production build.
 *
 * "Not production" is the permissive branch, so the default must fail safe: an
 * unparseable or missing NODE_ENV is treated as production by the env schema's own
 * default only in the sense that it validates; here we key off the validated value.
 */
import { getEnv } from './env';
import { NotFoundError } from '@/server/errors/app-error';

/** Whether developer-only tooling may exist in this process. */
export function isDevToolingEnabled(): boolean {
  const env = getEnv();
  if (env.isProduction) return false;
  return env.ENABLE_DEV_SWITCHER;
}

/**
 * Guard for every developer-only route and server action.
 *
 * Throws **404, not 403**. A 403 would confirm the endpoint exists and is merely
 * refused, which tells an attacker exactly which build they are talking to and what to
 * look for next. 404 makes a production deployment indistinguishable from one where the
 * feature was never written.
 */
export function assertDevToolingEnabled(): void {
  if (!isDevToolingEnabled()) {
    throw new NotFoundError('Not found');
  }
}
