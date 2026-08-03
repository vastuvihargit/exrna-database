/**
 * Structured logging (Pino → stdout, collected by Docker).
 *
 * Redaction is not optional here: physical storage paths, session tokens and password
 * hashes must never be written to a log that gets shipped off the host.
 */
import pino, { type Logger } from 'pino';
import { getEnv } from '@/server/config/env';

const REDACTED_PATHS = [
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  'tokenHash',
  '*.tokenHash',
  'csrfToken',
  '*.csrfToken',
  'authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.cookie',
  'cookie',
  '*.cookie',
  'secret',
  '*.secret',
  'refreshToken',
  '*.refreshToken',
  // Storage internals — a leaked absolute path is a security finding, not a convenience.
  'absolutePath',
  '*.absolutePath',
  'storageKey',
  '*.storageKey',
  'relativeStoragePath',
  '*.relativeStoragePath',
];

let instance: Logger | null = null;

function create(): Logger {
  const env = getEnv();
  const isPretty = env.isDevelopment && process.env.NO_PRETTY_LOGS !== '1';

  return pino({
    level: env.LOG_LEVEL,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    base: { service: 'biotech-drive', env: env.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    ...(isPretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
          },
        }
      : {}),
  });
}

export function getLogger(): Logger {
  instance ??= create();
  return instance;
}

/** A logger bound to a request id so every line of one request can be correlated. */
export function requestLogger(requestId: string, extra?: Record<string, unknown>): Logger {
  return getLogger().child({ requestId, ...extra });
}
