/**
 * The MongoDB role repository — the implementation that serves production today.
 *
 * Unchanged from the pre-module-2 `role.repository.ts` except that the unused
 * `session?: ClientSession` parameters were dropped (no caller passed one) and the scope-shape
 * assertion is now called explicitly rather than relying on the model's `pre('validate')`
 * hook — so both implementations refuse the same input at the same point.
 *
 * `getActorGrants` is the hot path — it runs on every authenticated request, so it is a single
 * query on userRoles joined to roles in memory (the role set is small and changes rarely).
 */
import { Types } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import {
  RoleModel,
  UserRoleModel,
  type RoleDocument,
  type UserRoleDocument,
} from '@/server/db/models';
import type { Permission, ScopeType } from '@/server/domain/permissions';
import type { ConfidentialityLevel } from '@/server/domain/permissions';
import type { RoleGrant } from '@/server/permissions/actor';
import {
  assertScopeShape,
  type GrantRoleInput,
  type GrantSummary,
  type RoleRecord,
  type RoleRepository,
} from './role.repository.contract';

type LeanRole = RoleDocument & { _id: Types.ObjectId };
type LeanUserRole = UserRoleDocument & { _id: Types.ObjectId };

function toRoleRecord(doc: LeanRole): RoleRecord {
  return {
    id: String(doc._id),
    organizationId: String(doc.organizationId),
    key: doc.key,
    name: doc.name,
    description: doc.description ?? '',
    permissions: (doc.permissions ?? []) as Permission[],
    scopeTypes: (doc.scopeTypes ?? []) as ScopeType[],
    rank: doc.rank,
    maxConfidentiality: (doc.maxConfidentiality ?? 'internal') as ConfidentialityLevel,
    companyWideRead: Boolean(doc.companyWideRead),
    isSystem: Boolean(doc.isSystem),
  };
}

function objectId(id: string): Types.ObjectId | null {
  return Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null;
}

export async function listRoles(organizationId: string): Promise<RoleRecord[]> {
  const orgId = objectId(organizationId);
  if (!orgId) return [];
  await connectToDatabase();
  const docs = await RoleModel.find({ organizationId: orgId })
    .sort({ rank: -1 })
    .lean<LeanRole[]>()
    .exec();
  return docs.map(toRoleRecord);
}

export async function findRoleById(id: string): Promise<RoleRecord | null> {
  const _id = objectId(id);
  if (!_id) return null;
  await connectToDatabase();
  const doc = await RoleModel.findOne({ _id }).lean<LeanRole>().exec();
  return doc ? toRoleRecord(doc) : null;
}

export async function findRolesByIds(ids: string[]): Promise<RoleRecord[]> {
  const valid = ids.map(objectId).filter((id): id is Types.ObjectId => id !== null);
  if (valid.length === 0) return [];
  await connectToDatabase();
  const docs = await RoleModel.find({ _id: { $in: valid } }).lean<LeanRole[]>().exec();
  return docs.map(toRoleRecord);
}

export async function findRoleByKey(
  organizationId: string,
  key: string,
): Promise<RoleRecord | null> {
  const orgId = objectId(organizationId);
  if (!orgId) return null;
  await connectToDatabase();
  const doc = await RoleModel.findOne({ organizationId: orgId, key: key.toLowerCase() })
    .lean<LeanRole>()
    .exec();
  return doc ? toRoleRecord(doc) : null;
}

/**
 * Every live role grant for a user, resolved into the shape the permission layer uses.
 * Expired and revoked grants are excluded by the query, not by a later filter.
 */
export async function getActorGrants(userId: string): Promise<RoleGrant[]> {
  const _userId = objectId(userId);
  if (!_userId) return [];
  await connectToDatabase();

  const now = new Date();
  const grants = await UserRoleModel.find({
    userId: _userId,
    revokedAt: null,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  })
    .lean<LeanUserRole[]>()
    .exec();

  if (grants.length === 0) return [];

  const roleIds = [...new Set(grants.map((grant) => String(grant.roleId)))].map(
    (id) => new Types.ObjectId(id),
  );
  const roles = await RoleModel.find({ _id: { $in: roleIds } }).lean<LeanRole[]>().exec();
  const roleById = new Map(roles.map((role) => [String(role._id), toRoleRecord(role)]));

  const resolved: RoleGrant[] = [];
  for (const grant of grants) {
    const role = roleById.get(String(grant.roleId));
    // A grant pointing at a deleted role confers nothing — fail closed.
    if (!role) continue;
    resolved.push({
      roleId: role.id,
      roleKey: role.key,
      roleName: role.name,
      rank: role.rank,
      scopeType: grant.scopeType as ScopeType,
      scopeId: grant.scopeId ? String(grant.scopeId) : null,
      permissions: role.permissions,
      maxConfidentiality: role.maxConfidentiality,
      companyWideRead: role.companyWideRead,
    });
  }
  return resolved;
}

export async function grantRole(input: GrantRoleInput): Promise<string> {
  assertScopeShape(input.scopeType, input.scopeId);
  await connectToDatabase();
  const [doc] = await UserRoleModel.create([
    {
      organizationId: new Types.ObjectId(input.organizationId),
      userId: new Types.ObjectId(input.userId),
      roleId: new Types.ObjectId(input.roleId),
      scopeType: input.scopeType,
      scopeId: input.scopeId ? new Types.ObjectId(input.scopeId) : null,
      grantedBy: new Types.ObjectId(input.grantedBy),
      grantedAt: new Date(),
      expiresAt: input.expiresAt ?? null,
    },
  ]);
  return String(doc!._id);
}

export async function revokeGrant(grantId: string, revokedBy: string): Promise<boolean> {
  const _id = objectId(grantId);
  if (!_id) return false;
  await connectToDatabase();
  const result = await UserRoleModel.updateOne(
    { _id, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedBy: new Types.ObjectId(revokedBy) } },
  ).exec();
  return result.modifiedCount > 0;
}

export async function listGrantsForUser(userId: string): Promise<GrantSummary[]> {
  const _userId = objectId(userId);
  if (!_userId) return [];
  await connectToDatabase();

  const grants = await UserRoleModel.find({ userId: _userId, revokedAt: null })
    .sort({ grantedAt: -1 })
    .lean<LeanUserRole[]>()
    .exec();
  if (grants.length === 0) return [];

  const roleIds = [...new Set(grants.map((grant) => String(grant.roleId)))].map(
    (id) => new Types.ObjectId(id),
  );
  const roles = await RoleModel.find({ _id: { $in: roleIds } }).lean<LeanRole[]>().exec();
  const roleById = new Map(roles.map((role) => [String(role._id), toRoleRecord(role)]));

  return grants.flatMap((grant) => {
    const role = roleById.get(String(grant.roleId));
    if (!role) return [];
    return [
      {
        id: String(grant._id),
        roleId: role.id,
        roleKey: role.key,
        roleName: role.name,
        rank: role.rank,
        scopeType: grant.scopeType as ScopeType,
        scopeId: grant.scopeId ? String(grant.scopeId) : null,
        grantedAt: grant.grantedAt,
        expiresAt: grant.expiresAt ?? null,
      },
    ];
  });
}

export async function findActiveGrant(
  userId: string,
  roleId: string,
  scopeType: ScopeType,
  scopeId: string | null,
): Promise<string | null> {
  const _userId = objectId(userId);
  const _roleId = objectId(roleId);
  if (!_userId || !_roleId) return null;

  /**
   * A `scopeId` that is not a valid ObjectId returns null rather than throwing.
   *
   * The previous version called `new Types.ObjectId(scopeId)` unguarded, so an unparseable
   * value threw where D1 simply matches nothing — a divergence, and the wrong direction of
   * one: this function answers "is this already granted?", and an exception on the way to
   * "no" turns a duplicate-grant check into a 500.
   */
  const _scopeId = scopeId === null ? null : objectId(scopeId);
  if (scopeId !== null && !_scopeId) return null;

  await connectToDatabase();
  const doc = await UserRoleModel.findOne({
    userId: _userId,
    roleId: _roleId,
    scopeType,
    scopeId: _scopeId,
    revokedAt: null,
  })
    .lean<LeanUserRole>()
    .exec();
  return doc ? String(doc._id) : null;
}

export const mongoRoleRepository: RoleRepository = {
  listRoles,
  findRoleById,
  findRolesByIds,
  findRoleByKey,
  getActorGrants,
  grantRole,
  revokeGrant,
  listGrantsForUser,
  findActiveGrant,
};
