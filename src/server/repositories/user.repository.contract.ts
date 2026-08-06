/**
 * The user repository contract, stated without reference to either database.
 *
 * The Mongoose repository leaked its query language upward: `list()` took a
 * `FilterQuery<UserDocument>` and `updateById()` took `{ $set: … }`. Both are MongoDB syntax,
 * and both were being constructed inside services — so "replace the repository" would have
 * meant "and also rewrite the callers", with no way to run the two implementations against
 * the same inputs.
 *
 * This file is the seam. Both implementations import these types, so a field one supports and
 * the other does not is a type error rather than a difference discovered in production.
 *
 * `UserRecord` is **unchanged** from the Mongoose version, field for field, including the
 * `Date` objects. Every DTO and every frontend hook downstream keeps working because nothing
 * downstream can tell which database produced the record.
 */
import type { UserStatus } from '@/server/db/models';

export interface UserRecord {
  id: string;
  organizationId: string;
  email: string;
  emailDomain: string;
  name: string;
  avatarUrl: string | null;
  jobTitle: string | null;
  status: UserStatus;
  isSuperAdmin: boolean;
  departmentId: string | null;
  projectIds: string[];
  storageQuotaBytes: number;
  storageUsedBytes: number;
  lastLoginAt: Date | null;
  lastActiveAt: Date | null;
  failedLoginCount: number;
  lockedUntil: Date | null;
  passwordUpdatedAt: Date | null;
  mustChangePassword: boolean;
  mfaEnabled: boolean;
  authProviders: string[];
  createdAt: Date;
  deactivatedAt: Date | null;
  deactivationReason: string | null;
}

/**
 * Replaces `{ filter: FilterQuery<UserDocument>, … }`.
 *
 * `organizationId` is required rather than optional. It was previously supplied inside an
 * opaque filter object produced by `userDirectoryFilter()`, which meant a caller could
 * construct a listing with no tenant predicate and nothing would object. Making it a named,
 * mandatory field means a cross-tenant listing cannot be written by accident.
 */
export interface ListUsersCriteria {
  organizationId: string;
  /** Email matches as a prefix, name as a substring — both case-insensitive. */
  search?: string;
  status?: UserStatus;
  departmentId?: string;
  isSuperAdmin?: boolean;
  page: number;
  pageSize: number;
  sort?: string;
  order?: 'asc' | 'desc';
}

/** The sort keys the Mongoose repository accepted. Anything else falls back to `name`. */
export const USER_SORT_FIELDS = ['name', 'email', 'createdAt', 'lastLoginAt', 'status'] as const;

/**
 * Replaces `{ $set: … }`.
 *
 * `undefined` means "leave this column alone"; `null` means "write null". The two are
 * different operations and the distinction is load-bearing — `setStatus()` clears
 * `deactivatedAt` on reactivation and must not clear it on any other update.
 */
export interface UserPatch {
  name?: string;
  jobTitle?: string | null;
  departmentId?: string | null;
  storageQuotaBytes?: number;
  storageUsedBytes?: number;
  status?: UserStatus;
  activatedAt?: Date | null;
  deactivatedAt?: Date | null;
  deactivatedBy?: string | null;
  deactivationReason?: string | null;
  failedLoginCount?: number;
  lockedUntil?: Date | null;
  lastActiveAt?: Date | null;
  mustChangePassword?: boolean;
}

export interface CreateUserInput {
  organizationId: string;
  email: string;
  emailDomain: string;
  name: string;
  jobTitle?: string | null;
  status: UserStatus;
  departmentId?: string | null;
  storageQuotaBytes: number;
  passwordHash?: string | null;
  isSuperAdmin?: boolean;
  invitedBy?: string | null;
  authProvider?: 'password' | 'google' | 'microsoft';
}

export interface FindForMentionsInput {
  organizationId: string;
  emails: string[];
  names: string[];
  limit?: number;
}

/**
 * Implemented by `user.repository.mongo.ts` and `user.repository.d1.ts`.
 *
 * The façade dispatches to one of them per call, so the two must stay interchangeable; this
 * interface is what makes the compiler check that.
 */
export interface UserRepository {
  findById(id: string): Promise<UserRecord | null>;
  findByIds(ids: string[]): Promise<UserRecord[]>;
  findByEmail(email: string): Promise<UserRecord | null>;
  findByEmailWithSecrets(
    email: string,
  ): Promise<{ user: UserRecord; passwordHash: string | null } | null>;
  findForMentions(input: FindForMentionsInput): Promise<UserRecord[]>;
  list(criteria: ListUsersCriteria): Promise<{ items: UserRecord[]; total: number }>;
  create(input: CreateUserInput): Promise<UserRecord>;
  updateById(id: string, patch: UserPatch): Promise<UserRecord | null>;
  setPasswordHash(id: string, passwordHash: string): Promise<void>;
  recordFailedLogin(id: string, lockThreshold: number): Promise<number>;
  recordSuccessfulLogin(id: string): Promise<void>;
  linkAuthProvider(
    id: string,
    provider: 'password' | 'google' | 'microsoft',
    providerAccountId: string | null,
  ): Promise<void>;
  countByOrganization(organizationId: string): Promise<number>;
}
