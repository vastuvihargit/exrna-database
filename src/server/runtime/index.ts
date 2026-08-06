/**
 * Which runtime is this code executing in, and what can it do?
 *
 * The application targets two runtimes during the Cloudflare migration: the existing Node
 * server, and a Cloudflare Worker. Most of the codebase does not need to know the difference
 * — the crypto helpers, the Drive client and every service run unchanged on both, because
 * they were already written against web-standard APIs or are pure logic.
 *
 * A small number of capabilities genuinely cannot be shared: a native Argon2 addon, a raw TCP
 * socket to ClamAV, a filesystem. This module is the one place that names them, so that
 * "what does not work in a Worker" is a list somebody can read rather than something
 * discovered when a build fails.
 *
 * **This is a seam, not a polyfill.** Nothing here makes a Node-only capability work in a
 * Worker. It makes the absence explicit and refusable, which is the difference between a
 * clear error and a mystery.
 */

export const RUNTIMES = ['node', 'workerd'] as const;
export type RuntimeName = (typeof RUNTIMES)[number];

/**
 * Cloudflare's runtime sets `navigator.userAgent` to exactly this string. It is the
 * documented detection method and, unlike sniffing for the absence of `process`, it does not
 * break when `nodejs_compat` polyfills more of Node than it did last month.
 */
const WORKERD_USER_AGENT = 'Cloudflare-Workers';

let override: RuntimeName | null = null;

export function detectRuntime(): RuntimeName {
  if (override) return override;

  const agent = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent;
  if (agent === WORKERD_USER_AGENT) return 'workerd';

  return 'node';
}

export function isWorkerRuntime(): boolean {
  return detectRuntime() === 'workerd';
}

export function isNodeRuntime(): boolean {
  return detectRuntime() === 'node';
}

/** Test-only. Lets a suite assert Worker behaviour without running inside workerd. */
export function setRuntimeOverride(name: RuntimeName | null): void {
  override = name;
}

/**
 * Capabilities that exist on the Node deployment and not in a Worker.
 *
 * Each one is a deliberate, documented gap with a resolution phase, not an oversight:
 *
 * | capability        | Worker | resolution                                              |
 * |-------------------|--------|---------------------------------------------------------|
 * | `passwordLogin`   | no     | Phase 8 — Cloudflare Access replaces password login       |
 * | `localFilesystem` | no     | Phase 1a — all bytes move to the Google Shared Drive      |
 * | `tcpSockets`      | no     | ClamAV over raw TCP; scanning is off by default already   |
 * | `mongoDatabase`   | no     | Phase 3 — repositories move to D1                         |
 */
export interface RuntimeCapabilities {
  passwordLogin: boolean;
  localFilesystem: boolean;
  tcpSockets: boolean;
  mongoDatabase: boolean;
}

const NODE_CAPABILITIES: RuntimeCapabilities = {
  passwordLogin: true,
  localFilesystem: true,
  tcpSockets: true,
  mongoDatabase: true,
};

const WORKER_CAPABILITIES: RuntimeCapabilities = {
  passwordLogin: false,
  localFilesystem: false,
  tcpSockets: false,
  mongoDatabase: false,
};

export function runtimeCapabilities(): RuntimeCapabilities {
  return detectRuntime() === 'workerd' ? WORKER_CAPABILITIES : NODE_CAPABILITIES;
}

export function hasCapability(name: keyof RuntimeCapabilities): boolean {
  return runtimeCapabilities()[name];
}

/**
 * Thrown when code reaches a capability the current runtime does not have.
 *
 * Deliberately a distinct error type. An operator reading a log needs to tell "this
 * deployment cannot do that" apart from "that failed", because the two have completely
 * different responses.
 */
export class UnsupportedRuntimeCapabilityError extends Error {
  readonly capability: keyof RuntimeCapabilities;
  readonly runtime: RuntimeName;

  constructor(capability: keyof RuntimeCapabilities, detail: string) {
    const runtime = detectRuntime();
    super(`${capability} is not available on the ${runtime} runtime. ${detail}`);
    this.name = 'UnsupportedRuntimeCapabilityError';
    this.capability = capability;
    this.runtime = runtime;
  }
}

export function assertCapability(
  name: keyof RuntimeCapabilities,
  detail: string,
): void {
  if (!hasCapability(name)) throw new UnsupportedRuntimeCapabilityError(name, detail);
}
