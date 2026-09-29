/**
 * Login history — a façade over the MongoDB and D1 implementations.
 *
 * Routed by `DATA_SOURCE_LOGIN_HISTORY`.
 *
 * On the login path in both directions: `auth.service.ts` writes a row for every attempt, and
 * the admin security view reads them. `record()` never throws on either engine — see the
 * contract for why that is correct here and nowhere else.
 */
import { isD1 } from './data-source';
import { mongoLoginHistoryRepository } from './login-history.repository.mongo';
import { d1LoginHistoryRepository } from './login-history.repository.d1';
import type {
  AdminLoginHistoryQuery,
  LoginAttemptInput,
  LoginHistoryRecord,
  LoginHistoryRepository,
  LoginOutcome,
} from './login-history.repository.contract';

export type {
  AdminLoginHistoryQuery,
  LoginAttemptInput,
  LoginHistoryRecord,
  LoginHistoryRepository,
  LoginOutcome,
};

export { mongoLoginHistoryRepository, d1LoginHistoryRepository };

function active(): LoginHistoryRepository {
  return isD1('loginHistory') ? d1LoginHistoryRepository : mongoLoginHistoryRepository;
}

export function record(input: LoginAttemptInput): Promise<void> {
  return active().record(input);
}

export function listForUser(userId: string, limit = 50): Promise<LoginHistoryRecord[]> {
  return active().listForUser(userId, limit);
}

export function query(
  options: AdminLoginHistoryQuery,
): Promise<{ items: LoginHistoryRecord[]; total: number }> {
  return active().query(options);
}

export function deleteOlderThan(cutoff: Date): Promise<number> {
  return active().deleteOlderThan(cutoff);
}
