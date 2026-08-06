/**
 * Administrator-editable folder and metadata templates.
 *
 * Both are stored as settings and both fall back to the seeded defaults, so a
 * fresh installation behaves identically to one that has never opened this page.
 *
 * The security shape of the two differs, and the difference is the whole design:
 *
 *  • A **folder template** is a list of names. Names are user-visible strings and are
 *    sanitized like every other folder name, so an administrator may write whatever they
 *    like there.
 *
 *  • A **metadata template** is a list of *field keys*, and those keys become MongoDB
 *    dotted paths under `File.metadata`. An administrator inventing a key here would
 *    reach exactly the write path the research-metadata allow-list exists to close. So
 *    a template may only *arrange* fields this codebase already declares — it selects
 *    from `METADATA_FIELDS`, it cannot extend it. Adding a genuinely new research field
 *    stays a code change, where it also gets a type, a form control and an index.
 */
import { ForbiddenError, NotFoundError, ValidationError } from '@/server/errors/app-error';
import {
  DEFAULT_DEPARTMENT_TEMPLATE,
  DEFAULT_PROJECT_TEMPLATE,
  flattenTemplate,
  type FolderTemplateEntry,
} from '@/server/domain/folder-templates';
import {
  METADATA_FIELDS,
  METADATA_TEMPLATES,
  metadataField,
  type MetadataTemplate,
} from '@/server/domain/research-metadata';
import { sanitizeDisplayName, isValidDisplayName } from '@/server/domain/naming';
import type { ConfidentialityLevel } from '@/server/domain/permissions';
import type { Actor } from '@/server/permissions/actor';
import { assertCompanyPermission } from '@/server/permissions/authorize';
import { auditService } from '@/server/audit/audit.service';
import * as settingRepository from '@/server/repositories/app-setting.repository';
import * as folderRepository from '@/server/repositories/folder.repository';
import type { RequestMeta } from '@/server/http/request-meta';

export const FOLDER_TEMPLATE_KEY = 'templates.folders';
export const METADATA_TEMPLATE_KEY = 'templates.metadata';

export interface FolderTemplateSet {
  project: FolderTemplateEntry[];
  department: FolderTemplateEntry[];
  /** False when the organization has never customized them. */
  customized: boolean;
}

/**
 * Editing templates reshapes every drive created from here on, company-wide.
 *
 * Gated on company-scoped `access.manage`, which is deliberately narrower than "is an
 * administrator": a department head holds `access.manage` for their own department and
 * has no business rewriting the template other departments' projects are built from.
 */
function assertMayEditTemplates(actor: Actor): void {
  try {
    assertCompanyPermission(actor, 'access.manage');
  } catch {
    throw new ForbiddenError('You cannot change company-wide templates');
  }
}

/* ------------------------------------------------------------ folder templates */

export async function getFolderTemplates(organizationId: string): Promise<FolderTemplateSet> {
  const stored = await settingRepository.get(organizationId, FOLDER_TEMPLATE_KEY);
  const value = stored?.value as
    | { project?: unknown; department?: unknown }
    | undefined;

  const project = readEntries(value?.project) ?? DEFAULT_PROJECT_TEMPLATE;
  const department = readEntries(value?.department) ?? DEFAULT_DEPARTMENT_TEMPLATE;

  return { project, department, customized: Boolean(stored) };
}

export interface FolderTemplateInput {
  project?: Array<{ key?: string; name: string; description?: string }>;
  department?: Array<{ key?: string; name: string; description?: string }>;
}

export async function saveFolderTemplates(
  actor: Actor,
  input: FolderTemplateInput,
  meta: RequestMeta,
): Promise<FolderTemplateSet> {
  assertMayEditTemplates(actor);

  const current = await getFolderTemplates(actor.organizationId);
  const project = input.project ? normalizeEntries(input.project, 'project') : current.project;
  const department = input.department
    ? normalizeEntries(input.department, 'department')
    : current.department;

  await settingRepository.put({
    organizationId: actor.organizationId,
    key: FOLDER_TEMPLATE_KEY,
    value: { project, department },
    description: 'Folder templates applied to new project and department drives',
    updatedBy: actor.userId,
  });

  await auditService.recordForActor(actor, meta, {
    action: 'settings.updated',
    entityType: 'template',
    entityId: FOLDER_TEMPLATE_KEY,
    entityLabel: 'Folder templates',
    previousValue: {
      project: current.project.map((entry) => entry.name),
      department: current.department.map((entry) => entry.name),
    },
    newValue: {
      project: project.map((entry) => entry.name),
      department: department.map((entry) => entry.name),
    },
    severity: 'notice',
  });

  return { project, department, customized: true };
}

/**
 * Existing drives are not rewritten.
 *
 * Renaming `06_Raw Data` in the template must not rename it in forty live projects: the
 * folder is full of files people have linked to and cited. A template describes what a
 * *new* drive starts with, and the project dashboard reports which template folders a
 * given drive is missing so the gap is visible rather than silently applied.
 */
function normalizeEntries(
  entries: Array<{ key?: string; name: string; description?: string }>,
  label: string,
): FolderTemplateEntry[] {
  if (entries.length === 0) {
    throw new ValidationError(`The ${label} template needs at least one folder`);
  }
  if (entries.length > 40) {
    throw new ValidationError(`A template may define at most 40 folders`);
  }

  const seen = new Set<string>();
  const out: FolderTemplateEntry[] = [];

  for (const [index, entry] of entries.entries()) {
    const name = sanitizeDisplayName(entry.name);
    if (!isValidDisplayName(name)) {
      throw new ValidationError(`Folder ${index + 1} in the ${label} template needs a valid name`);
    }
    const lower = name.toLowerCase();
    // The drive itself enforces unique names per parent; catching it here turns a
    // half-built template into a validation message instead of a half-built drive.
    if (seen.has(lower)) {
      throw new ValidationError(`"${name}" appears twice in the ${label} template`);
    }
    seen.add(lower);

    out.push({
      key: normalizeKey(entry.key ?? name, index),
      name,
      description: (entry.description ?? '').trim().slice(0, 300),
    });
  }

  return out;
}

/** Template keys are stable identifiers, not display text — kept to a safe alphabet. */
function normalizeKey(raw: string, index: number): string {
  const key = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return key || `folder_${index + 1}`;
}

function readEntries(value: unknown): FolderTemplateEntry[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: FolderTemplateEntry[] = [];
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.name !== 'string' || entry.name.length === 0) continue;
    out.push({
      key: typeof entry.key === 'string' ? entry.key : `folder_${index + 1}`,
      name: entry.name,
      description: typeof entry.description === 'string' ? entry.description : '',
    });
  }
  return out.length > 0 ? out : null;
}

/* --------------------------------------------------------------- application */

/**
 * Creates the template folders inside a fresh drive root.
 *
 * Idempotent by name: reopening a drive whose creation was interrupted fills in what is
 * missing and touches nothing that already exists. That is what makes it safe to call on
 * every root access rather than only at creation time — a project whose drive build
 * failed halfway repairs itself the next time someone opens it.
 *
 * It lives here rather than in the project or drive service because both need it and
 * they already depend on each other; a copy in each would be the second place to forget
 * a fix.
 */
export async function applyFolderTemplate(input: {
  organizationId: string;
  actorUserId: string;
  rootFolderId: string;
  kind: 'project' | 'department';
  confidentiality: ConfidentialityLevel;
}): Promise<number> {
  // Internal: the template builder runs on behalf of the drive, not of a viewer — the
  // caller has already authorized opening the drive whose root this is.
  const root = await folderRepository.findByIdInternal(input.rootFolderId);
  if (!root) throw new NotFoundError();

  const templates = await getFolderTemplates(input.organizationId);
  const entries = flattenTemplate(input.kind === 'project' ? templates.project : templates.department);

  const existing = await folderRepository.takenChildNames(root.id);
  const createdByKey = new Map<string, string>();
  let created = 0;

  for (const entry of entries) {
    const parentId = entry.parentKey ? createdByKey.get(entry.parentKey) : root.id;
    if (!parentId) continue;
    if (parentId === root.id && existing.has(entry.name.toLowerCase())) continue;

    const parent =
      parentId === root.id ? root : await folderRepository.findByIdInternal(parentId);
    if (!parent) continue;

    const folder = await folderRepository.create({
      organizationId: input.organizationId,
      name: entry.name,
      parentFolderId: parent.id,
      pathAncestors: [...parent.pathAncestors, parent.id],
      depth: parent.depth + 1,
      driveType: root.driveType,
      ownerId: root.ownerId,
      departmentId: root.departmentId,
      projectId: root.projectId,
      confidentiality: input.confidentiality,
      description: entry.description,
      templateKey: entry.key,
      createdBy: input.actorUserId,
    });
    createdByKey.set(entry.key, folder.id);
    created += 1;
  }

  if (created > 0) await folderRepository.adjustChildFolderCount(root.id, created);
  return created;
}

/** Template folders a drive root is missing, so a dashboard can report the gap. */
export async function missingTemplateFolders(input: {
  organizationId: string;
  rootFolderId: string;
  kind: 'project' | 'department';
}): Promise<Array<{ key: string; name: string }>> {
  const templates = await getFolderTemplates(input.organizationId);
  const entries = flattenTemplate(
    input.kind === 'project' ? templates.project : templates.department,
  );
  const taken = await folderRepository.takenChildNames(input.rootFolderId);

  return entries
    .filter((entry) => !entry.parentKey && !taken.has(entry.name.toLowerCase()))
    .map((entry) => ({ key: entry.key, name: entry.name }));
}

/* ---------------------------------------------------------- metadata templates */

export interface MetadataTemplateSet {
  templates: MetadataTemplate[];
  /** The fields a template may draw on. The client renders a picker from this. */
  fields: typeof METADATA_FIELDS;
  customized: boolean;
}

export async function getMetadataTemplates(organizationId: string): Promise<MetadataTemplateSet> {
  const stored = await settingRepository.get(organizationId, METADATA_TEMPLATE_KEY);
  const templates = readTemplates(stored?.value) ?? [...METADATA_TEMPLATES];
  return { templates, fields: METADATA_FIELDS, customized: Boolean(stored) };
}

export interface MetadataTemplateInput {
  templates: Array<{
    key: string;
    label: string;
    description?: string;
    fieldKeys: string[];
    recommendedKeys?: string[];
  }>;
}

export async function saveMetadataTemplates(
  actor: Actor,
  input: MetadataTemplateInput,
  meta: RequestMeta,
): Promise<MetadataTemplateSet> {
  assertMayEditTemplates(actor);

  const current = await getMetadataTemplates(actor.organizationId);
  const templates = normalizeTemplates(input.templates);

  await settingRepository.put({
    organizationId: actor.organizationId,
    key: METADATA_TEMPLATE_KEY,
    value: templates,
    description: 'Research metadata form templates',
    updatedBy: actor.userId,
  });

  await auditService.recordForActor(actor, meta, {
    action: 'settings.updated',
    entityType: 'template',
    entityId: METADATA_TEMPLATE_KEY,
    entityLabel: 'Metadata templates',
    previousValue: { templates: current.templates.map((template) => template.key) },
    newValue: { templates: templates.map((template) => template.key) },
    severity: 'notice',
  });

  return { templates, fields: METADATA_FIELDS, customized: true };
}

function normalizeTemplates(
  input: MetadataTemplateInput['templates'],
): MetadataTemplate[] {
  if (input.length === 0) throw new ValidationError('Keep at least one metadata template');
  if (input.length > 25) throw new ValidationError('At most 25 metadata templates');

  const seen = new Set<string>();
  const out: MetadataTemplate[] = [];

  for (const raw of input) {
    const key = normalizeKey(raw.key, out.length);
    if (seen.has(key)) throw new ValidationError(`Two templates share the key "${key}"`);
    seen.add(key);

    const label = sanitizeDisplayName(raw.label);
    if (!label) throw new ValidationError('Every template needs a label');

    // The allow-list check. An unknown key here would become a dotted path under
    // `File.metadata` the moment someone filled the form in.
    const fieldKeys: string[] = [];
    for (const fieldKey of raw.fieldKeys) {
      if (!metadataField(fieldKey)) {
        throw new ValidationError(`"${fieldKey}" is not a research metadata field`, [
          { path: 'fieldKeys', message: 'Unknown field' },
        ]);
      }
      if (!fieldKeys.includes(fieldKey)) fieldKeys.push(fieldKey);
    }
    if (fieldKeys.length === 0) throw new ValidationError(`Template "${label}" has no fields`);

    const recommendedKeys = (raw.recommendedKeys ?? []).filter((fieldKey) =>
      fieldKeys.includes(fieldKey),
    );

    out.push({
      key,
      label,
      description: (raw.description ?? '').trim().slice(0, 300),
      fieldKeys,
      recommendedKeys,
    });
  }

  // `general` is the fallback every uncategorized file lands on; losing it would leave
  // those files with no form at all.
  if (!out.some((template) => template.key === 'general')) {
    const fallback = METADATA_TEMPLATES.find((template) => template.key === 'general');
    if (fallback) out.push(fallback);
  }

  return out;
}

function readTemplates(value: unknown): MetadataTemplate[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: MetadataTemplate[] = [];

  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.key !== 'string' || typeof entry.label !== 'string') continue;

    // Re-filtered on read as well as on write. A field removed from the codebase after a
    // template referenced it would otherwise resurface as a form control writing a key
    // nothing validates.
    const fieldKeys = Array.isArray(entry.fieldKeys)
      ? entry.fieldKeys.filter(
          (fieldKey): fieldKey is string => typeof fieldKey === 'string' && Boolean(metadataField(fieldKey)),
        )
      : [];
    if (fieldKeys.length === 0) continue;

    out.push({
      key: entry.key,
      label: entry.label,
      description: typeof entry.description === 'string' ? entry.description : '',
      fieldKeys,
      recommendedKeys: Array.isArray(entry.recommendedKeys)
        ? entry.recommendedKeys.filter(
            (fieldKey): fieldKey is string =>
              typeof fieldKey === 'string' && fieldKeys.includes(fieldKey),
          )
        : [],
    });
  }

  return out.length > 0 ? out : null;
}

export const templateService = {
  getFolderTemplates,
  saveFolderTemplates,
  applyFolderTemplate,
  missingTemplateFolders,
  getMetadataTemplates,
  saveMetadataTemplates,
};
