/**
 * Research metadata: what a file can be annotated with, and what a form should ask for.
 *
 * The field set is a closed allow-list rather than a free-form object. Two reasons:
 *
 *  1. Security. `File.metadata` is a Mixed subdocument, so an attacker-controlled key
 *     like `$where`, `__proto__` or `a.b` would be written verbatim into the document
 *     and could later be interpreted as an operator or a dotted path. An allow-list of
 *     known keys makes that unreachable — there is no code path that writes a key this
 *     module did not declare.
 *
 *  2. Search. The text index on `File` names specific metadata paths
 *     (`metadata.sampleId`, `metadata.experimentCode`, `metadata.description`). Fields
 *     invented per-upload would never be searchable, which is exactly the problem the
 *     platform exists to solve.
 *
 * Templates decide which of these fields a *form* shows. They never restrict what may be
 * stored: a file that moves between categories keeps the annotations it already has,
 * because silently dropping recorded research data would be worse than showing a field
 * the template no longer suggests.
 */
import { ValidationError } from '@/server/errors/app-error';
import { FILE_CATEGORIES, type FileCategory } from './file-types';

export const METADATA_FIELD_TYPES = ['text', 'longtext', 'date', 'number', 'select', 'list'] as const;
export type MetadataFieldType = (typeof METADATA_FIELD_TYPES)[number];

export interface MetadataFieldDefinition {
  key: string;
  label: string;
  type: MetadataFieldType;
  /** Shown under the input. Kept short — a form full of paragraphs does not get filled in. */
  hint?: string;
  /** For `select`. The stored value must be one of these. */
  options?: readonly string[];
  maxLength?: number;
  min?: number;
  max?: number;
  /** For `list`. */
  maxItems?: number;
}

export const DOCUMENT_TYPES = [
  'protocol',
  'sop',
  'raw_data',
  'processed_data',
  'analysis',
  'result',
  'report',
  'proposal',
  'presentation',
  'certificate',
  'approval',
  'other',
] as const;

export const DATA_TYPES = [
  'sequencing',
  'mass_spectrometry',
  'chromatography',
  'imaging',
  'flow_cytometry',
  'qpcr',
  'assay',
  'survey',
  'simulation',
  'other',
] as const;

export const RESULT_OUTCOMES = ['pending', 'positive', 'negative', 'inconclusive', 'failed'] as const;

/**
 * Every annotation the platform understands. Adding one here is the only change needed
 * for it to be storable, validated, form-rendered and filterable — but a field that
 * should also be *full-text* searchable needs a matching path in the `file_search` index
 * in `file.model.ts`.
 */
export const METADATA_FIELDS: readonly MetadataFieldDefinition[] = [
  {
    key: 'study',
    label: 'Study',
    type: 'text',
    hint: 'The study or programme this file belongs to',
    maxLength: 200,
  },
  {
    key: 'experimentCode',
    label: 'Experiment code',
    type: 'text',
    hint: 'e.g. EXP-2026-014',
    maxLength: 60,
  },
  {
    key: 'sampleId',
    label: 'Sample ID',
    type: 'text',
    hint: 'The identifier printed on the tube or plate',
    maxLength: 60,
  },
  { key: 'researcher', label: 'Researcher', type: 'text', maxLength: 120 },
  { key: 'protocol', label: 'Protocol', type: 'text', maxLength: 200 },
  { key: 'instrument', label: 'Instrument', type: 'text', maxLength: 120 },
  {
    key: 'organism',
    label: 'Organism / material',
    type: 'text',
    hint: 'Species, cell line or biological material',
    maxLength: 120,
  },
  { key: 'batchLot', label: 'Batch / lot', type: 'text', maxLength: 60 },
  { key: 'researchDate', label: 'Research date', type: 'date' },
  { key: 'documentType', label: 'Document type', type: 'select', options: DOCUMENT_TYPES },
  { key: 'dataType', label: 'Data type', type: 'select', options: DATA_TYPES },
  { key: 'result', label: 'Result', type: 'select', options: RESULT_OUTCOMES },
  {
    key: 'replicate',
    label: 'Replicate',
    type: 'number',
    hint: 'Replicate number within the experiment',
    min: 1,
    max: 10_000,
  },
  {
    key: 'keywords',
    label: 'Keywords',
    type: 'list',
    hint: 'Free terms that should find this file',
    maxItems: 25,
    maxLength: 40,
  },
  {
    key: 'description',
    label: 'Description',
    type: 'longtext',
    hint: 'What this file is, in a sentence or two',
    maxLength: 2000,
  },
];

const FIELDS_BY_KEY = new Map(METADATA_FIELDS.map((field) => [field.key, field]));

export const METADATA_FIELD_KEYS = METADATA_FIELDS.map((field) => field.key);

export function metadataField(key: string): MetadataFieldDefinition | undefined {
  return FIELDS_BY_KEY.get(key);
}

/* ------------------------------------------------------------------ templates */

export interface MetadataTemplate {
  key: string;
  label: string;
  description: string;
  /** Ordered — this is the form layout. */
  fieldKeys: readonly string[];
  /** Fields the form marks as expected. Never enforced server-side; see below. */
  recommendedKeys?: readonly string[];
}

const CORE: readonly string[] = ['study', 'experimentCode', 'researcher', 'researchDate', 'description'];

/**
 * Templates are suggestions, not schemas.
 *
 * Nothing here is enforced on write. A half-annotated file is more useful than an upload
 * the researcher abandoned because a mandatory field asked for a batch number they did
 * not have yet — and the spec is explicit that not every field may be mandatory.
 */
export const METADATA_TEMPLATES: readonly MetadataTemplate[] = [
  {
    key: 'general',
    label: 'General',
    description: 'Applies to any file. The fallback when nothing more specific fits.',
    fieldKeys: [...CORE, 'documentType', 'keywords'],
    recommendedKeys: ['description'],
  },
  {
    key: 'experiment',
    label: 'Experiment data',
    description: 'Bench output tied to a sample and a protocol.',
    fieldKeys: [
      ...CORE,
      'sampleId',
      'protocol',
      'instrument',
      'organism',
      'batchLot',
      'replicate',
      'dataType',
      'result',
      'keywords',
    ],
    recommendedKeys: ['experimentCode', 'sampleId', 'researchDate'],
  },
  {
    key: 'sequencing',
    label: 'Sequencing run',
    description: 'FASTQ, BAM, VCF and the run metadata that makes them interpretable.',
    fieldKeys: [
      ...CORE,
      'sampleId',
      'organism',
      'instrument',
      'protocol',
      'batchLot',
      'replicate',
      'dataType',
      'keywords',
    ],
    recommendedKeys: ['sampleId', 'organism', 'instrument'],
  },
  {
    key: 'instrument_output',
    label: 'Instrument output',
    description: 'Mass-spec, chromatography and cytometry output straight off the machine.',
    fieldKeys: [...CORE, 'sampleId', 'instrument', 'protocol', 'batchLot', 'dataType', 'result', 'keywords'],
    recommendedKeys: ['instrument', 'sampleId'],
  },
  {
    key: 'protocol',
    label: 'Protocol / SOP',
    description: 'Procedures and standard operating documents.',
    fieldKeys: ['study', 'researcher', 'researchDate', 'protocol', 'instrument', 'documentType', 'keywords', 'description'],
    recommendedKeys: ['protocol', 'documentType'],
  },
  {
    key: 'analysis',
    label: 'Analysis / report',
    description: 'Processed data, notebooks, figures and written reports.',
    fieldKeys: [...CORE, 'sampleId', 'dataType', 'result', 'documentType', 'keywords'],
    recommendedKeys: ['description', 'result'],
  },
];

const TEMPLATES_BY_KEY = new Map(METADATA_TEMPLATES.map((template) => [template.key, template]));

/** The template a form should open with for a freshly uploaded file of this category. */
const TEMPLATE_BY_CATEGORY: Record<FileCategory, string> = {
  document: 'general',
  spreadsheet: 'analysis',
  presentation: 'general',
  image: 'experiment',
  raw_data: 'experiment',
  sequence: 'sequencing',
  chromatography: 'instrument_output',
  archive: 'general',
  code: 'analysis',
  video: 'experiment',
  audio: 'general',
  other: 'general',
};

export function templateForCategory(category: string): MetadataTemplate {
  const key = TEMPLATE_BY_CATEGORY[category as FileCategory] ?? 'general';
  return TEMPLATES_BY_KEY.get(key) ?? TEMPLATES_BY_KEY.get('general')!;
}

export function findTemplate(key: string): MetadataTemplate | undefined {
  return TEMPLATES_BY_KEY.get(key);
}

/** Every category maps to a template — asserted here so a new category cannot be forgotten. */
export function assertTemplateCoverage(): void {
  for (const category of FILE_CATEGORIES) {
    if (!TEMPLATE_BY_CATEGORY[category]) {
      throw new Error(`No metadata template mapped for file category "${category}"`);
    }
  }
}

/* ----------------------------------------------------------------- validation */

/**
 * Normalizes a metadata patch, rejecting anything not declared above.
 *
 * Returns a `$set`-shaped patch: a key set to `null` means "clear this annotation", and
 * the caller turns those into `$unset`. Clearing has to be expressible, otherwise a
 * mistyped sample ID could never be removed — only overwritten.
 */
export function validateResearchMetadata(
  input: Record<string, unknown>,
): { set: Record<string, unknown>; unset: string[] } {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];

  for (const [key, raw] of Object.entries(input)) {
    const field = FIELDS_BY_KEY.get(key);
    if (!field) {
      throw new ValidationError(`"${key}" is not a research metadata field`, [
        { path: `metadata.${key}`, message: 'Unknown field' },
      ]);
    }

    if (raw === null || raw === undefined || raw === '') {
      unset.push(key);
      continue;
    }

    set[key] = coerce(field, raw);
  }

  return { set, unset };
}

function coerce(field: MetadataFieldDefinition, raw: unknown): unknown {
  const fail = (message: string): never => {
    throw new ValidationError(`${field.label}: ${message}`, [
      { path: `metadata.${field.key}`, message },
    ]);
  };

  switch (field.type) {
    case 'text':
    case 'longtext': {
      if (typeof raw !== 'string') return fail('must be text');
      const value = raw.trim().replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ');
      if (value.length === 0) return fail('cannot be blank');
      if (field.maxLength && value.length > field.maxLength) {
        return fail(`must be ${field.maxLength} characters or fewer`);
      }
      return value;
    }

    case 'number': {
      const value = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(value)) return fail('must be a number');
      if (field.min !== undefined && value < field.min) return fail(`must be at least ${field.min}`);
      if (field.max !== undefined && value > field.max) return fail(`must be at most ${field.max}`);
      return value;
    }

    case 'date': {
      if (typeof raw !== 'string' && !(raw instanceof Date)) return fail('must be a date');
      const value = raw instanceof Date ? raw : new Date(raw);
      if (Number.isNaN(value.getTime())) return fail('is not a valid date');
      // Stored as an ISO day, not a timestamp: "the day the experiment ran" has no
      // meaningful time-of-day, and keeping one invites timezone drift in every listing.
      return value.toISOString().slice(0, 10);
    }

    case 'select': {
      if (typeof raw !== 'string') return fail('must be one of the listed options');
      if (!field.options?.includes(raw)) {
        return fail(`must be one of: ${field.options?.join(', ') ?? ''}`);
      }
      return raw;
    }

    case 'list': {
      if (!Array.isArray(raw)) return fail('must be a list');
      const values = raw
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry) => entry.length > 0);
      if (field.maxItems && values.length > field.maxItems) {
        return fail(`may have at most ${field.maxItems} entries`);
      }
      for (const value of values) {
        if (field.maxLength && value.length > field.maxLength) {
          return fail(`each entry must be ${field.maxLength} characters or fewer`);
        }
      }
      return [...new Set(values)];
    }
  }
}
