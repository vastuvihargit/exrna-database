/**
 * A `pino`-shaped structured logger for the Cloudflare Worker runtime.
 *
 * Pino writes to a Node stream and, through `pino-pretty`, uses worker threads. Neither
 * exists in workerd. This is a drop-in replacement for the small slice of pino's surface
 * `src/server/logging/logger.ts` actually uses, emitting one JSON object per line to
 * `console`, which Workers Logs ingests directly.
 *
 * **The redaction list is the reason this file is not three lines of `console.log`.**
 * `logger.ts` relies on pino's `redact.paths` to keep `storageKey`, `absolutePath`,
 * `tokenHash`, `cookie` and `authorization` out of the logs, and a leaked storage path is a
 * security finding in this codebase, not a cosmetic one. Dropping to a plain console logger
 * in the Worker would silently remove that protection in exactly the environment where the
 * logs are most widely readable. So the wildcard path matching is reimplemented here.
 *
 * Aliased in place of `pino` for the Cloudflare build only — see `next.config.ts`. The Node
 * deployment keeps real pino, unchanged.
 */

type Level = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

const LEVEL_ORDER: Record<Level | 'silent', number> = {
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10,
  silent: Number.POSITIVE_INFINITY,
};

interface RedactOptions {
  paths?: string[];
  censor?: string;
}

interface PinoOptions {
  level?: string;
  redact?: RedactOptions;
  base?: Record<string, unknown>;
  timestamp?: unknown;
  formatters?: unknown;
  transport?: unknown;
}

export interface ShimLogger {
  level: string;
  fatal(object: unknown, message?: string): void;
  error(object: unknown, message?: string): void;
  warn(object: unknown, message?: string): void;
  info(object: unknown, message?: string): void;
  debug(object: unknown, message?: string): void;
  trace(object: unknown, message?: string): void;
  child(bindings: Record<string, unknown>): ShimLogger;
}

/**
 * Splits pino's redaction paths into exact matches (`req.headers.cookie`) and
 * leaf-name matches (`*.password`), which are the only two forms this codebase uses.
 */
function compileRedaction(paths: string[]): { exact: Set<string>; anyDepth: Set<string> } {
  const exact = new Set<string>();
  const anyDepth = new Set<string>();

  for (const path of paths) {
    if (path.startsWith('*.')) {
      anyDepth.add(path.slice(2));
    } else {
      exact.add(path);
      // A bare `password` must also match a top-level key.
      if (!path.includes('.')) anyDepth.add(path);
    }
  }

  return { exact, anyDepth };
}

const MAX_DEPTH = 8;

function redactValue(
  value: unknown,
  compiled: { exact: Set<string>; anyDepth: Set<string> },
  censor: string,
  trail: string,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;

  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, compiled, censor, trail, depth + 1, seen));
  }

  // Errors do not survive a spread; keep the fields an operator actually reads.
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const path = trail ? `${trail}.${key}` : key;

    if (compiled.anyDepth.has(key) || compiled.exact.has(path)) {
      out[key] = censor;
      continue;
    }
    out[key] = redactValue(entry, compiled, censor, path, depth + 1, seen);
  }
  return out;
}

function create(options: PinoOptions, bindings: Record<string, unknown>): ShimLogger {
  const level = options.level ?? 'info';
  const threshold = LEVEL_ORDER[level as Level] ?? LEVEL_ORDER.info;
  const censor = options.redact?.censor ?? '[redacted]';
  const compiled = compileRedaction(options.redact?.paths ?? []);

  function emit(levelName: Level, objectOrMessage: unknown, maybeMessage?: string): void {
    if (LEVEL_ORDER[levelName] < threshold) return;

    const hasObject = typeof objectOrMessage === 'object' && objectOrMessage !== null;
    const message = hasObject ? maybeMessage : (objectOrMessage as string | undefined);

    const payload = hasObject
      ? (redactValue(objectOrMessage, compiled, censor, '', 0, new WeakSet()) as Record<
          string,
          unknown
        >)
      : {};

    const line = {
      level: levelName,
      time: new Date().toISOString(),
      ...options.base,
      ...bindings,
      ...payload,
      ...(message !== undefined ? { msg: message } : {}),
    };

    // Workers Logs captures console output. `error` and `warn` keep their own channels so
    // the platform's own severity filtering agrees with ours.
    const serialized = JSON.stringify(line);
    if (levelName === 'fatal' || levelName === 'error') console.error(serialized);
    else if (levelName === 'warn') console.warn(serialized);
    else console.log(serialized);
  }

  return {
    level,
    fatal: (object, message) => emit('fatal', object, message),
    error: (object, message) => emit('error', object, message),
    warn: (object, message) => emit('warn', object, message),
    info: (object, message) => emit('info', object, message),
    debug: (object, message) => emit('debug', object, message),
    trace: (object, message) => emit('trace', object, message),
    child: (extra) => create(options, { ...bindings, ...extra }),
  };
}

function pino(options: PinoOptions = {}): ShimLogger {
  return create(options, {});
}

/** `logger.ts` reads `pino.stdTimeFunctions.isoTime`; the shim always emits ISO time. */
pino.stdTimeFunctions = {
  isoTime: () => `,"time":"${new Date().toISOString()}"`,
  epochTime: () => `,"time":${Date.now()}`,
  unixTime: () => `,"time":${Math.round(Date.now() / 1000)}`,
  nullTime: () => '',
};

export default pino;
export { pino };
