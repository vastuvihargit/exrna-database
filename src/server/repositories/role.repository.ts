/**
 * Role and role-grant repository.
 *
 * `getActorGrants` is the hot path — it runs on every authenticated request, so it is
 * a single query on userRoles joined to roles in memory (the role set is small and
 * changes rarely).
 */
import { Types, type ClientSession } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { RoleModel, UserRoleModel, type RoleDocument, type UserRoleDocument } from '@/server/db/models';
import type { ConfidentialityLevel, Permission, ScopeType } from '@/server/domain/permissions';
import type { RoleGrant } from '@/server/permissions/actor';

export interface RoleRecord {
  id: string;
  organizationId: string;
  key: string;
  name: string;
  description: string;
  permissions: Permission[];
  scopeTypes: ScopeType[];
  rank: number;
  maxConfidentiality: ConfidentialityLevel;
  companyWideRead: boolean;
  isSystem: boolean;
}

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

export async function listRoles(organizationId: string): Promise<RoleRecord[]> {
  await connectToDatabase();
  const docs = await RoleModel.find({ organizationId: new Types.ObjectId(organizationId) })
    .sort({ rank: -1 })
    .lean<LeanRole[]>()
    .exec();
  return docs.map(toRoleRecord);
}

export async function findRoleById(id: string): Promise<RoleRecord | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  await connectToDatabase();
  const doc = await RoleModel.findOne({ _id: new Types.ObjectId(id) }).lean<LeanRole>().exec();
  return doc ? toRoleRecord(doc) : null;
}

export async function findRolesByIds(ids: string[]): Promise<RoleRecord[]> {
  const valid = ids.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
  if (valid.length === 0) return [];
  await connectToDatabase();
  const docs = await RoleModel.find({ _id: { $in: valid } }).lean<LeanRole[]>().exec();
  return docs.map(toRoleRecord);
}

export async function findRoleByKey(organizationId: string, key: string): Promise<RoleRecord | null> {
  await connectToDatabase();
  const doc = await RoleModel.findOne({
    organizationId: new Types.ObjectId(organizationId),
    key: key.toLowerCase(),
  })
    .lean<LeanRole>()
    .exec();
  return doc ? toRoleRecord(doc) : null;
}

/**
 * Every live role grant for a user, resolved into the shape the permission layer uses.
 * Expired and revoked grants are excluded by the query, not by a later filter.
 */
export async function getActorGrants(userId: string): Promise<RoleGrant[]> {
  if (!Types.ObjectId.isValid(userId)) return [];
  await connectToDatabase();

  const now = new Date();
  const grants = await UserRoleModel.find({
    userId: new Types.ObjectId(userId),
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

export interface GrantRoleInput {
  organizationId: string;
  userId: string;
  roleId: string;
  scopeType: ScopeType;
  scopeId: string | null;
  grantedBy: string;
  expiresAt?: Date | null;
}

export async function grantRole(input: GrantRoleInput, session?: ClientSession): Promise<string> {
  await connectToDatabase();
  const [doc] = await UserRoleModel.create(
    [
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
    ],
    session ? { session } : undefined,
  );
  return String(doc!._id);
}

export async function revokeGrant(
  grantId: string,
  revokedBy: string,
  session?: ClientSession,
): Promise<boolean> {
  if (!Types.ObjectId.isValid(grantId)) return false;
  await connectToDatabase();
  const result = await UserRoleModel.updateOne(
    { _id: new Types.ObjectId(grantId), revokedAt: null },
    { $set: { revokedAt: new Date(), revokedBy: new Types.ObjectId(revokedBy) } },
    session ? { session } : undefined,
  ).exec();
  return result.modifiedCount > 0;
}

export interface GrantSummary {
  id: string;
  roleId: string;
  roleKey: string;
  roleName: string;
  rank: number;
  scopeType: ScopeType;
  scopeId: string | null;
  grantedAt: Date;
  expiresAt: Date | null;
}

export async function listGrantsForUser(userId: string): Promise<GrantSummary[]> {
  if (!Types.ObjectId.isValid(userId)) return [];
  await connectToDatabase();

  const grants = await UserRoleModel.find({ userId: new Types.ObjectId(userId), revokedAt: null })
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
  await connectToDatabase();
  const doc = await UserRoleModel.findOne({
    userId: new Types.ObjectId(userId),
    roleId: new Types.ObjectId(roleId),
    scopeType,
    scopeId: scopeId ? new Types.ObjectId(scopeId) : null,
    revokedAt: null,
  })
    .lean<LeanUserRole>()
    .exec();
  return doc ? String(doc._id) : null;
}
