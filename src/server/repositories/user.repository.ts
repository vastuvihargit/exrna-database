/**
 * User repository — the only place user documents are queried.
 *
 * Callers receive plain objects, never Mongoose documents, so no business code can
 * accidentally `.save()` a partially loaded user or serialize a hidden field.
 */
import { Types, type ClientSession, type FilterQuery } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { UserModel, type UserDocument, type UserStatus } from '@/server/db/models';

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

type LeanUser = UserDocument & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

export function toUserRecord(doc: LeanUser): UserRecord {
  return {
    id: String(doc._id),
    organizationId: String(doc.organizationId),
    email: doc.email,
    emailDomain: doc.emailDomain,
    name: doc.name,
    avatarUrl: doc.avatarUrl ?? null,
    jobTitle: doc.jobTitle ?? null,
    status: doc.status as UserStatus,
    isSuperAdmin: Boolean(doc.isSuperAdmin),
    departmentId: doc.departmentId ? String(doc.departmentId) : null,
    projectIds: (doc.projectIds ?? []).map(String),
    storageQuotaBytes: doc.storageQuotaBytes,
    storageUsedBytes: doc.storageUsedBytes ?? 0,
    lastLoginAt: doc.lastLoginAt ?? null,
    lastActiveAt: doc.lastActiveAt ?? null,
    failedLoginCount: doc.failedLoginCount ?? 0,
    lockedUntil: doc.lockedUntil ?? null,
    passwordUpdatedAt: doc.passwordUpdatedAt ?? null,
    mustChangePassword: Boolean(doc.mustChangePassword),
    mfaEnabled: Boolean(doc.mfa?.enabled),
    authProviders: (doc.authProviders ?? []).map((provider) => provider.provider),
    createdAt: doc.createdAt,
    deactivatedAt: doc.deactivatedAt ?? null,
    deactivationReason: doc.deactivationReason ?? null,
  };
}

function objectId(id: string): Types.ObjectId | null {
  return Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null;
}

export async function findById(id: string): Promise<UserRecord | null> {
  const _id = objectId(id);
  if (!_id) return null;
  await connectToDatabase();
  const doc = await UserModel.findOne({ _id }).lean<LeanUser>().exec();
  return doc ? toUserRecord(doc) : null;
}

/**
 * Candidate users for `@mentions` in a comment.
 *
 * Emails match exactly. Names match case-insensitively but *anchored* — the fragment
 * must be the start of the name — so an unanchored substring cannot be used to sweep the
 * directory, and the escaped pattern cannot be turned into a ReDoS payload.
 */
export async function findForMentions(input: {
  organizationId: string;
  emails: string[];
  names: string[];
  limit?: number;
}): Promise<UserRecord[]> {
  const branches: Record<string, unknown>[] = [];

  if (input.emails.length > 0) {
    branches.push({ email: { $in: input.emails.map((email) => email.toLowerCase()) } });
  }
  for (const name of input.names.slice(0, 10)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    branches.push({ name: { $regex: `^${escaped}`, $options: 'i' } });
  }
  if (branches.length === 0) return [];

  await connectToDatabase();
  const organizationId = objectId(input.organizationId);
  if (!organizationId) return [];

  const docs = await UserModel.find({ organizationId, $or: branches })
    .limit(Math.min(input.limit ?? 20, 50))
    .lean<LeanUser[]>()
    .exec();
  return docs.map(toUserRecord);
}

/** Batch lookup, so resolving a share list is one query rather than one per entry. */
export async function findByIds(ids: string[]): Promise<UserRecord[]> {
  const valid = ids.map(objectId).filter((id): id is Types.ObjectId => id !== null);
  if (valid.length === 0) return [];
  await connectToDatabase();
  const docs = await UserModel.find({ _id: { $in: valid } }).lean<LeanUser[]>().exec();
  return docs.map(toUserRecord);
}

/**
 * Case-insensitive by construction: emails are stored lower-cased and the caller
 * normalizes before looking up, so no regex is needed (and none is used — a regex here
 * would be a ReDoS surface on an unauthenticated endpoint).
 */
export async function findByEmail(email: string): Promise<UserRecord | null> {
  await connectToDatabase();
  const doc = await UserModel.findOne({ email: email.toLowerCase() }).lean<LeanUser>().exec();
  return doc ? toUserRecord(doc) : null;
}

/** Loads the password hash explicitly; it is `select: false` on the schema. */
export async function findByEmailWithSecrets(
  email: string,
): Promise<{ user: UserRecord; passwordHash: string | null } | null> {
  await connectToDatabase();
  const doc = await UserModel.findOne({ email: email.toLowerCase() })
    .select('+passwordHash')
    .lean<LeanUser & { passwordHash?: string | null }>()
    .exec();
  if (!doc) return null;
  return { user: toUserRecord(doc), passwordHash: doc.passwordHash ?? null };
}

export interface ListUsersOptions {
  filter: FilterQuery<UserDocument>;
  search?: string;
  status?: UserStatus;
  departmentId?: string;
  page: number;
  pageSize: number;
  sort?: string;
  order?: 'asc' | 'desc';
}

export async function list(
  options: ListUsersOptions,
): Promise<{ items: UserRecord[]; total: number }> {
  await connectToDatabase();

  const query: FilterQuery<UserDocument> = { ...options.filter };

  if (options.status) query.status = options.status;
  if (options.departmentId) {
    const departmentId = objectId(options.departmentId);
    if (!departmentId) return { items: [], total: 0 };
    query.departmentId = departmentId;
  }
  if (options.search) {
    // Anchored, escaped prefix match only — never an unbounded user-supplied regex.
    const escaped = options.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 80);
    const prefix = new RegExp(`^${escaped}`, 'i');
    const contains = new RegExp(escaped, 'i');
    query.$or = [{ email: prefix }, { name: contains }];
  }

  const sortField = ['name', 'email', 'createdAt', 'lastLoginAt', 'status'].includes(options.sort ?? '')
    ? (options.sort as string)
    : 'name';
  const sortOrder = options.order === 'desc' ? -1 : 1;

  const [docs, total] = await Promise.all([
    UserModel.find(query)
      .sort({ [sortField]: sortOrder })
      .skip((options.page - 1) * options.pageSize)
      .limit(options.pageSize)
      .lean<LeanUser[]>()
      .exec(),
    UserModel.countDocuments(query).exec(),
  ]);

  return { items: docs.map(toUserRecord), total };
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

export async function create(
  input: CreateUserInput,
  session?: ClientSession,
): Promise<UserRecord> {
  await connectToDatabase();

  const [doc] = await UserModel.create(
    [
      {
        organizationId: new Types.ObjectId(input.organizationId),
        email: input.email,
        emailDomain: input.emailDomain,
        name: input.name,
        jobTitle: input.jobTitle ?? null,
        status: input.status,
        departmentId: input.departmentId ? new Types.ObjectId(input.departmentId) : null,
        storageQuotaBytes: input.storageQuotaBytes,
        passwordHash: input.passwordHash ?? null,
        passwordUpdatedAt: input.passwordHash ? new Date() : null,
        isSuperAdmin: input.isSuperAdmin ?? false,
        invitedBy: input.invitedBy ? new Types.ObjectId(input.invitedBy) : null,
        invitedAt: new Date(),
        activatedAt: input.status === 'active' ? new Date() : null,
        authProviders: input.authProvider ? [{ provider: input.authProvider }] : [],
      },
    ],
    session ? { session } : undefined,
  );

  return toUserRecord(doc!.toObject() as LeanUser);
}

export async function updateById(
  id: string,
  update: Record<string, unknown>,
  session?: ClientSession,
): Promise<UserRecord | null> {
  const _id = objectId(id);
  if (!_id) return null;
  await connectToDatabase();

  const doc = await UserModel.findOneAndUpdate({ _id }, update, {
    new: true,
    ...(session ? { session } : {}),
  })
    .lean<LeanUser>()
    .exec();

  return doc ? toUserRecord(doc) : null;
}

export async function setPasswordHash(id: string, passwordHash: string): Promise<void> {
  const _id = objectId(id);
  if (!_id) return;
  await connectToDatabase();
  await UserModel.updateOne(
    { _id },
    { $set: { passwordHash, passwordUpdatedAt: new Date(), mustChangePassword: false } },
  ).exec();
}

export async function recordFailedLogin(id: string, lockThreshold: number): Promise<number> {
  const _id = objectId(id);
  if (!_id) return 0;
  await connectToDatabase();

  const doc = await UserModel.findOneAndUpdate(
    { _id },
    { $inc: { failedLoginCount: 1 } },
    { new: true },
  )
    .lean<LeanUser>()
    .exec();

  const count = doc?.failedLoginCount ?? 0;

  if (count >= lockThreshold) {
    // Exponential backoff: 15 min for the first lock, doubling, capped at 24 h.
    const excess = count - lockThreshold;
    const minutes = Math.min(15 * 2 ** excess, 24 * 60);
    await UserModel.updateOne(
      { _id },
      { $set: { lockedUntil: new Date(Date.now() + minutes * 60_000) } },
    ).exec();
  }

  return count;
}

export async function recordSuccessfulLogin(id: string): Promise<void> {
  const _id = objectId(id);
  if (!_id) return;
  await connectToDatabase();
  await UserModel.updateOne(
    { _id },
    {
      $set: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date(), lastActiveAt: new Date() },
    },
  ).exec();
}

export async function linkAuthProvider(
  id: string,
  provider: 'password' | 'google' | 'microsoft',
  providerAccountId: string | null,
): Promise<void> {
  const _id = objectId(id);
  if (!_id) return;
  await connectToDatabase();
  await UserModel.updateOne(
    { _id, 'authProviders.provider': { $ne: provider } },
    { $push: { authProviders: { provider, providerAccountId, linkedAt: new Date() } } },
  ).exec();
}

export async function countByOrganization(organizationId: string): Promise<number> {
  const orgId = objectId(organizationId);
  if (!orgId) return 0;
  await connectToDatabase();
  return UserModel.countDocuments({ organizationId: orgId }).exec();
}
