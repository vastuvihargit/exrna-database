import { describe, expect, it } from 'vitest';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  QuotaExceededError,
  StorageError,
  UnauthenticatedError,
  ValidationError,
  isAppError,
} from '@/server/errors/app-error';

describe('AppError hierarchy', () => {
  it('maps each error type to the documented status code', () => {
    expect(new ValidationError().status).toBe(422);
    expect(new UnauthenticatedError().status).toBe(401);
    expect(new ForbiddenError().status).toBe(403);
    expect(new NotFoundError().status).toBe(404);
    expect(new ConflictError().status).toBe(409);
    expect(new QuotaExceededError().status).toBe(507);
  });

  it('carries a stable machine-readable code', () => {
    expect(new ForbiddenError().code).toBe('FORBIDDEN');
    expect(new ConflictError('circular', 'CIRCULAR_MOVE').code).toBe('CIRCULAR_MOVE');
  });

  // Storage messages can contain filesystem paths, so they are never exposed.
  it('marks storage errors as not safe to expose', () => {
    const error = new StorageError('STORAGE_ERROR', '/data/storage/originals/abc failed');
    expect(error.expose).toBe(false);
    expect(error.status).toBe(500);
  });

  it('treats key-validation failures as client errors', () => {
    expect(new StorageError('INVALID_KEY', 'bad key').status).toBe(400);
    expect(new StorageError('PATH_ESCAPE', 'escape').status).toBe(400);
  });

  it('identifies application errors', () => {
    expect(isAppError(new NotFoundError())).toBe(true);
    expect(isAppError(new Error('plain'))).toBe(false);
    expect(isAppError(null)).toBe(false);
  });

  it('preserves the cause chain for logging', () => {
    const cause = new Error('ENOENT');
    const error = new AppError('INTERNAL_ERROR', 'wrapped', 500, { cause });
    expect(error.cause).toBe(cause);
  });
});
