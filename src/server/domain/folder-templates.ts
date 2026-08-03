/**
 * Project folder templates.
 *
 * A new project drive starts with the same twelve folders every time. That is the
 * single largest fix for "employees do not know where a document is stored": if every
 * project looks identical, a protocol is always in `03_Protocols and SOPs`.
 *
 * Administrators can edit the stored template (Phase 9); these are the seeded defaults.
 */
export interface FolderTemplateEntry {
  /** Stable key, so a renamed folder is still recognisably "the protocols folder". */
  key: string;
  name: string;
  description: string;
  children?: FolderTemplateEntry[];
}

export const DEFAULT_PROJECT_TEMPLATE: FolderTemplateEntry[] = [
  { key: 'overview', name: '01_Project Overview', description: 'Charter, scope, team and timeline.' },
  { key: 'proposal', name: '02_Research Proposal', description: 'Proposals, grant documents and approvals to start.' },
  { key: 'protocols', name: '03_Protocols and SOPs', description: 'Approved protocols and standard operating procedures.' },
  { key: 'experiments', name: '04_Experiments', description: 'Experiment plans, run sheets and logs.' },
  { key: 'samples', name: '05_Samples', description: 'Sample manifests, batch and lot records.' },
  { key: 'raw_data', name: '06_Raw Data', description: 'Instrument output exactly as produced. Never edited in place.' },
  { key: 'processed_data', name: '07_Processed Data', description: 'Cleaned and normalized datasets.' },
  { key: 'analysis', name: '08_Analysis', description: 'Scripts, notebooks and statistical analysis.' },
  { key: 'results', name: '09_Results', description: 'Figures, tables and result summaries.' },
  { key: 'reports', name: '10_Reports', description: 'Draft and final reports and manuscripts.' },
  { key: 'approvals', name: '11_Approvals', description: 'Signed approvals and review decisions.' },
  { key: 'archived', name: '12_Archived Files', description: 'Superseded material kept for traceability.' },
];

/** Departments get a lighter default — they are not projects. */
export const DEFAULT_DEPARTMENT_TEMPLATE: FolderTemplateEntry[] = [
  { key: 'dept_sops', name: 'Protocols and SOPs', description: 'Department-wide procedures.' },
  { key: 'dept_projects', name: 'Projects', description: 'Shared material that spans several projects.' },
  { key: 'dept_equipment', name: 'Equipment and Instruments', description: 'Calibration, maintenance and manuals.' },
  { key: 'dept_reports', name: 'Reports', description: 'Department reporting and summaries.' },
];

export function flattenTemplate(
  entries: FolderTemplateEntry[],
): Array<{ key: string; name: string; description: string; parentKey: string | null }> {
  const out: Array<{ key: string; name: string; description: string; parentKey: string | null }> = [];
  const walk = (list: FolderTemplateEntry[], parentKey: string | null) => {
    for (const entry of list) {
      out.push({ key: entry.key, name: entry.name, description: entry.description, parentKey });
      if (entry.children?.length) walk(entry.children, entry.key);
    }
  };
  walk(entries, null);
  return out;
}
