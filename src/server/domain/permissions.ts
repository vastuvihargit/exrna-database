/**
 * The permission vocabulary.
 *
 * One definition, three consumers: the TypeScript type, the Zod schema, and the
 * Mongoose enum. Adding a permission here is the only place it needs to be declared.
 *
 * See docs/phase-0/05-auth-and-permissions.md for the role matrix.
 */

export const PERMISSIONS = [
  'file.view',
  'file.preview',
  'file.upload',
  'file.download',
  'folder.create',
  'resource.rename',
  'resource.move',
  'resource.copy',
  'comment.create',
  'share.internal',
  'metadata.edit',
  'version.upload',
  'review.submit',
  'review.perform',
  'review.approve',
  'resource.archive',
  'resource.restore',
  'resource.delete',
  'resource.export',
  'access.manage',
  'user.manage',
  'audit.view',
  /**
   * Inventory management.
   *
   * Reading is separated from the three ways stock can move, because the people who need
   * to know what is on the shelf are almost everyone, and the people who may change what
   * is on the shelf are a handful. `inventory.stock.adjust` is separate again: corrections
   * and write-offs are the operations that can make a discrepancy disappear, so they are
   * the ones a store manager should not hold by default.
   */
  'inventory.view',
  'inventory.item.manage',
  'inventory.stock.add',
  'inventory.stock.issue',
  'inventory.stock.adjust',
  'inventory.request',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_SET = new Set<string>(PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && PERMISSION_SET.has(value);
}

/** Where a role grant or an ACL entry applies. */
export const SCOPE_TYPES = ['company', 'department', 'project', 'folder', 'file'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

/** Who a share is granted to. */
export const PRINCIPAL_TYPES = ['user', 'department', 'project', 'role'] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

/**
 * Share access levels, expressed as permission bundles.
 * Ordered least → most privileged; `manager` is a superset of everything shareable.
 */
export const ACCESS_LEVELS = [
  'viewer',
  'commenter',
  'editor',
  'reviewer',
  'approver',
  'manager',
] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

const VIEWER: Permission[] = ['file.view', 'file.preview', 'file.download'];
const COMMENTER: Permission[] = [...VIEWER, 'comment.create'];
const EDITOR: Permission[] = [
  ...COMMENTER,
  'file.upload',
  'folder.create',
  'resource.rename',
  'resource.move',
  'resource.copy',
  'metadata.edit',
  'version.upload',
  'review.submit',
];
const REVIEWER: Permission[] = [...COMMENTER, 'review.perform'];
const APPROVER: Permission[] = [...REVIEWER, 'review.approve'];
const MANAGER: Permission[] = [
  ...new Set<Permission>([
    ...EDITOR,
    ...APPROVER,
    'share.internal',
    'access.manage',
    'resource.archive',
    'resource.restore',
    'resource.delete',
    'resource.export',
  ]),
];

export const ACCESS_LEVEL_PERMISSIONS: Record<AccessLevel, readonly Permission[]> = {
  viewer: VIEWER,
  commenter: COMMENTER,
  editor: EDITOR,
  reviewer: REVIEWER,
  approver: APPROVER,
  manager: MANAGER,
};

export function permissionsForAccessLevel(level: AccessLevel): readonly Permission[] {
  return ACCESS_LEVEL_PERMISSIONS[level];
}

/**
 * Actions the owner of a resource may always perform on it, without an explicit grant.
 *
 * This is what makes a personal drive work: My Drive folders carry no department or
 * project, so no role scope reaches them and ownership is the only route in.
 *
 * Deliberately excludes approval — you never approve your own work — and access.manage,
 * which stays with the people who administer sharing.
 */
export const OWNER_PERMISSIONS: readonly Permission[] = [
  'file.view',
  'file.preview',
  'file.download',
  'file.upload',
  'folder.create',
  'resource.rename',
  'resource.move',
  'resource.copy',
  'metadata.edit',
  'version.upload',
  'review.submit',
  'comment.create',
  'resource.archive',
  'resource.restore',
  'resource.delete',
  'share.internal',
];

/** Confidentiality classification, ordered least → most sensitive. */
export const CONFIDENTIALITY_LEVELS = [
  'public_internal',
  'internal',
  'confidential',
  'restricted',
] as const;
export type ConfidentialityLevel = (typeof CONFIDENTIALITY_LEVELS)[number];

export const CONFIDENTIALITY_RANK: Record<ConfidentialityLevel, number> = {
  public_internal: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

/**
 * `restricted` is intentionally absent from every clearance list: reaching a restricted
 * file always requires an explicit grant on the file or its folder, never role scope
 * alone (docs/phase-0/05, resolution step 9).
 */
export const CLEARANCE_BY_MAX_LEVEL: Record<ConfidentialityLevel, ConfidentialityLevel[]> = {
  public_internal: ['public_internal'],
  internal: ['public_internal', 'internal'],
  confidential: ['public_internal', 'internal', 'confidential'],
  restricted: ['public_internal', 'internal', 'confidential'],
};
