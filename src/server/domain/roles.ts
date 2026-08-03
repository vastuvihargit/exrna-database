/**
 * The ten default roles.
 *
 * Roles are stored in MongoDB (so administrators can create their own) and seeded from
 * these definitions. `rank` implements "you cannot grant a role above your own" —
 * higher number means more privileged.
 *
 * `maxConfidentiality` is the highest classification the role can reach through role
 * scope alone. `restricted` files always additionally require an explicit grant.
 */
import type { ConfidentialityLevel, Permission, ScopeType } from './permissions';

export interface RoleDefinition {
  key: string;
  name: string;
  description: string;
  rank: number;
  scopeTypes: ScopeType[];
  permissions: Permission[];
  maxConfidentiality: ConfidentialityLevel;
  /** Company-wide visibility of every resource, subject to the confidentiality gate. */
  companyWideRead: boolean;
}

/**
 * `inventory.view` sits in the base bundle deliberately.
 *
 * What is on the shelf is operational information, not research content: an employee who
 * cannot find out whether there is any Trizol left has to ask somebody, and the answer they
 * get is worse than the one the system already has. Nothing about *changing* stock comes
 * with it — those permissions belong only to the two roles at the bottom of this file.
 */
const VIEW: Permission[] = ['file.view', 'file.preview', 'inventory.view'];
const READ: Permission[] = [...VIEW, 'file.download'];

const CONTRIBUTOR: Permission[] = [
  ...READ,
  'file.upload',
  'folder.create',
  'resource.rename',
  'resource.move',
  'resource.copy',
  'comment.create',
  'metadata.edit',
  'version.upload',
  'review.submit',
  'inventory.request',
];

/** The full inventory surface, held by the inventory administrator. */
const INVENTORY_FULL: Permission[] = [
  'inventory.view',
  'inventory.item.manage',
  'inventory.stock.add',
  'inventory.stock.issue',
  'inventory.stock.adjust',
];

const MANAGEMENT: Permission[] = [
  ...CONTRIBUTOR,
  'share.internal',
  'review.perform',
  'review.approve',
  'resource.archive',
  'resource.restore',
  'resource.delete',
  'resource.export',
  'access.manage',
  'audit.view',
];

/**
 * The inventory permissions are listed here as well as on `inventory_admin` for a reason
 * that is not redundancy: `assertCanGrantRole` refuses to let anyone grant a permission
 * they do not hold themselves. Without them, a company administrator could not appoint an
 * inventory administrator.
 */
const ALL_PERMISSIONS: Permission[] = [
  ...new Set<Permission>([...MANAGEMENT, 'user.manage', ...INVENTORY_FULL]),
];

export const DEFAULT_ROLES: RoleDefinition[] = [
  {
    key: 'super_admin',
    name: 'Super Admin',
    description: 'Unrestricted platform administration. Break-glass account — every action is audited.',
    rank: 100,
    scopeTypes: ['company'],
    permissions: ALL_PERMISSIONS,
    maxConfidentiality: 'restricted',
    companyWideRead: true,
  },
  {
    key: 'company_admin',
    name: 'Company Admin',
    description: 'Manages employees, departments, roles and platform settings.',
    rank: 90,
    scopeTypes: ['company'],
    permissions: ALL_PERMISSIONS,
    maxConfidentiality: 'confidential',
    companyWideRead: true,
  },
  {
    key: 'rd_head',
    name: 'R&D Head',
    description: 'Oversees all research departments and projects.',
    rank: 80,
    scopeTypes: ['company', 'department'],
    permissions: MANAGEMENT,
    maxConfidentiality: 'confidential',
    companyWideRead: true,
  },
  {
    key: 'department_head',
    name: 'Department Head',
    description: 'Manages one department: its members, drives and approvals.',
    rank: 70,
    scopeTypes: ['department'],
    permissions: [...MANAGEMENT, 'user.manage'],
    maxConfidentiality: 'confidential',
    companyWideRead: false,
  },
  {
    key: 'project_lead',
    name: 'Project Lead',
    description: 'Leads a research project: its files, experiments, reviews and access.',
    rank: 60,
    scopeTypes: ['project', 'folder'],
    permissions: MANAGEMENT,
    maxConfidentiality: 'confidential',
    companyWideRead: false,
  },
  {
    key: 'research_scientist',
    name: 'Research Scientist',
    description: 'Creates and organizes research data within their projects.',
    rank: 50,
    scopeTypes: ['department', 'project', 'folder'],
    permissions: [...CONTRIBUTOR, 'share.internal', 'resource.archive', 'resource.restore', 'resource.delete', 'resource.export'],
    maxConfidentiality: 'confidential',
    companyWideRead: false,
  },
  {
    key: 'lab_technician',
    name: 'Lab Technician',
    description: 'Uploads experimental data and raw results.',
    rank: 40,
    scopeTypes: ['department', 'project', 'folder'],
    permissions: [...READ, 'file.upload', 'folder.create', 'comment.create', 'metadata.edit', 'version.upload', 'review.submit'],
    maxConfidentiality: 'internal',
    companyWideRead: false,
  },
  {
    key: 'data_analyst',
    name: 'Data Analyst',
    description: 'Analyses research data and produces processed datasets and reports.',
    rank: 45,
    scopeTypes: ['department', 'project', 'folder'],
    permissions: [...CONTRIBUTOR, 'share.internal', 'resource.export'],
    maxConfidentiality: 'confidential',
    companyWideRead: false,
  },
  {
    key: 'reviewer',
    name: 'Reviewer',
    description: 'Reviews documents assigned to them and requests changes.',
    rank: 55,
    scopeTypes: ['company', 'department', 'project', 'file'],
    permissions: [...READ, 'comment.create', 'review.perform'],
    maxConfidentiality: 'confidential',
    companyWideRead: false,
  },
  /**
   * Inventory roles.
   *
   * Both can be granted at company scope (a central store) or at department scope (that
   * department's own stock). The scope is what `assertInventoryPermission` matches against
   * the item's custodian department, so a department store manager cannot issue another
   * department's reagents.
   *
   * Neither carries `companyWideRead`: running the store is not a reason to be able to read
   * every research file in the company. They hold ordinary read access to files so that a
   * certificate of analysis linked to an item can actually be opened.
   */
  {
    key: 'inventory_admin',
    name: 'Inventory Admin',
    description: 'Full control of the inventory: items, receipts, issues and corrections.',
    rank: 65,
    scopeTypes: ['company', 'department'],
    permissions: [...READ, ...INVENTORY_FULL],
    maxConfidentiality: 'internal',
    companyWideRead: false,
  },
  {
    key: 'store_manager',
    name: 'Store Manager',
    description: 'Receives deliveries and issues stock. Cannot alter item definitions or make corrections.',
    rank: 42,
    scopeTypes: ['company', 'department'],
    permissions: [...READ, 'inventory.view', 'inventory.stock.add', 'inventory.stock.issue'],
    maxConfidentiality: 'internal',
    companyWideRead: false,
  },
  {
    key: 'management_viewer',
    name: 'Management Viewer',
    description: 'Read-only oversight. Cannot download, and never sees confidential or restricted files.',
    rank: 30,
    scopeTypes: ['company', 'department'],
    permissions: [...VIEW, 'comment.create'],
    maxConfidentiality: 'internal',
    companyWideRead: true,
  },
];

export const DEFAULT_ROLE_KEYS = DEFAULT_ROLES.map((role) => role.key);

export function findRoleDefinition(key: string): RoleDefinition | undefined {
  return DEFAULT_ROLES.find((role) => role.key === key);
}
