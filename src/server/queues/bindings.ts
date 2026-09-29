/**
 * Queue producer bindings, resolved per call from the request's Cloudflare context.
 *
 * Same reasoning as `db/d1-context.ts`: a binding belongs to the in-flight invocation, so it is
 * looked up when needed rather than captured at module scope. On Node there is no such binding
 * and `null` is the honest answer — callers fall back to doing the work inline, which is what
 * the Node deployment has always done.
 */
import { isWorkerRuntime } from '@/server/runtime';

const CLOUDFLARE_CONTEXT = Symbol.for('__cloudflare-context__');

/** The subset of `Queue` the producers use. Declared here to keep workers-types out of `src`. */
export interface QueueProducer<Body = unknown> {
  send(body: Body, options?: { delaySeconds?: number }): Promise<void>;
}

export type QueueBindingName = 'SYNC_QUEUE' | 'NOTIFICATION_QUEUE';

let injected: Partial<Record<QueueBindingName, QueueProducer>> | null = null;

/** Test-only: hand in producer doubles, so the Worker path is exercised without workerd. */
export function setQueueBindingsForTesting(
  bindings: Partial<Record<QueueBindingName, QueueProducer>> | null,
): void {
  injected = bindings;
}

export function getQueueProducer<Body>(name: QueueBindingName): QueueProducer<Body> | null {
  if (injected) return (injected[name] as QueueProducer<Body> | undefined) ?? null;
  if (!isWorkerRuntime()) return null;

  const context = (globalThis as Record<symbol, { env?: Record<string, unknown> } | undefined>)[
    CLOUDFLARE_CONTEXT
  ];
  const binding = context?.env?.[name] as QueueProducer<Body> | undefined;
  return binding && typeof binding.send === 'function' ? binding : null;
}
