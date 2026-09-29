/**
 * Work that should finish after the response has been sent.
 *
 * The codebase already detaches secondary writes — activity rows, "recent" entries, one audit
 * record — with `void promise.catch(() => undefined)`, so the person waiting is not also waiting
 * on bookkeeping. On Node that is sound: the process outlives the response and the promise
 * completes.
 *
 * **In a Worker it is not.** workerd may cancel any outstanding I/O once the response has been
 * returned, unless the promise was registered with `ctx.waitUntil`. A bare `void` there is a
 * write that usually happens and sometimes silently does not, which for an audit record is the
 * worst kind of unreliable.
 *
 * `detach` is the same fire-and-forget shape with that one difference: in a Worker it hands the
 * promise to `waitUntil`; everywhere else it behaves exactly as `void … .catch()` did. Failures
 * are logged rather than swallowed, because a swallowed failure is invisible and these are the
 * writes nobody is watching.
 */
import { getLogger } from '@/server/logging/logger';

/** The request-scoped context OpenNext publishes; read directly so this stays synchronous. */
const CLOUDFLARE_CONTEXT = Symbol.for('__cloudflare-context__');

interface WaitUntilContext {
  ctx?: { waitUntil?: (promise: Promise<unknown>) => void };
}

function waitUntil(): ((promise: Promise<unknown>) => void) | null {
  const context = (globalThis as Record<symbol, WaitUntilContext | undefined>)[CLOUDFLARE_CONTEXT];
  const fn = context?.ctx?.waitUntil;
  return typeof fn === 'function' ? fn.bind(context?.ctx) : null;
}

export function detach(work: Promise<unknown>, label: string): void {
  const guarded = work.catch((error: unknown) => {
    getLogger().warn({ err: error, work: label }, 'Background write failed');
  });
  const register = waitUntil();
  if (register) register(guarded);
}
