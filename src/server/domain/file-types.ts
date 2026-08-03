/**
 * What may be uploaded, and what it is.
 *
 * The policy is an allow-list, not a block-list. A block-list of "dangerous" extensions
 * is a game you lose: there is always one more (.hta, .msc, .scf, .lnk, …). Research
 * data is a bounded set of formats, so enumerating what is *wanted* is both safer and
 * more honest about the platform's purpose.
 *
 * Nothing here is executed by the server under any circumstance; the allow-list exists
 * so that the platform does not become a distribution point for something a colleague
 * downloads and double-clicks.
 */

export const FILE_CATEGORIES = [
  'document',
  'spreadsheet',
  'presentation',
  'image',
  'raw_data',
  'sequence',
  'chromatography',
  'archive',
  'code',
  'video',
  'audio',
  'other',
] as const;
export type FileCategory = (typeof FILE_CATEGORIES)[number];

export interface FileTypeRule {
  extension: string;
  /** MIME types a browser may plausibly report for this extension. */
  mimeTypes: string[];
  category: FileCategory;
  /** Safe to render in the browser (Phase 5 preview). */
  previewable: boolean;
  /**
   * Served with `Content-Disposition: attachment` and a neutral content type even when
   * previewable — anything the browser might execute in our origin.
   */
  forceDownload?: boolean;
}

const RULES: FileTypeRule[] = [
  // Documents
  { extension: 'pdf', mimeTypes: ['application/pdf'], category: 'document', previewable: true },
  { extension: 'txt', mimeTypes: ['text/plain'], category: 'document', previewable: true },
  { extension: 'md', mimeTypes: ['text/markdown', 'text/plain'], category: 'document', previewable: true },
  { extension: 'rtf', mimeTypes: ['application/rtf', 'text/rtf'], category: 'document', previewable: false },
  {
    extension: 'doc',
    mimeTypes: ['application/msword'],
    category: 'document',
    previewable: false,
  },
  {
    extension: 'docx',
    mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    category: 'document',
    previewable: false,
  },

  // Spreadsheets
  { extension: 'csv', mimeTypes: ['text/csv', 'application/csv', 'text/plain'], category: 'spreadsheet', previewable: true },
  { extension: 'tsv', mimeTypes: ['text/tab-separated-values', 'text/plain'], category: 'spreadsheet', previewable: true },
  { extension: 'xls', mimeTypes: ['application/vnd.ms-excel'], category: 'spreadsheet', previewable: false },
  {
    extension: 'xlsx',
    mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    category: 'spreadsheet',
    previewable: false,
  },

  // Presentations
  { extension: 'ppt', mimeTypes: ['application/vnd.ms-powerpoint'], category: 'presentation', previewable: false },
  {
    extension: 'pptx',
    mimeTypes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    category: 'presentation',
    previewable: false,
  },

  // Images
  { extension: 'png', mimeTypes: ['image/png'], category: 'image', previewable: true },
  { extension: 'jpg', mimeTypes: ['image/jpeg'], category: 'image', previewable: true },
  { extension: 'jpeg', mimeTypes: ['image/jpeg'], category: 'image', previewable: true },
  { extension: 'gif', mimeTypes: ['image/gif'], category: 'image', previewable: true },
  { extension: 'webp', mimeTypes: ['image/webp'], category: 'image', previewable: true },
  { extension: 'bmp', mimeTypes: ['image/bmp'], category: 'image', previewable: true },
  { extension: 'tif', mimeTypes: ['image/tiff'], category: 'image', previewable: false },
  { extension: 'tiff', mimeTypes: ['image/tiff'], category: 'image', previewable: false },
  // SVG is XML and can carry script: allowed for storage, never rendered inline.
  { extension: 'svg', mimeTypes: ['image/svg+xml'], category: 'image', previewable: false, forceDownload: true },

  // Structured data
  { extension: 'json', mimeTypes: ['application/json', 'text/plain'], category: 'raw_data', previewable: true },
  { extension: 'xml', mimeTypes: ['application/xml', 'text/xml'], category: 'raw_data', previewable: true },
  { extension: 'yaml', mimeTypes: ['application/x-yaml', 'text/yaml', 'text/plain'], category: 'raw_data', previewable: true },
  { extension: 'yml', mimeTypes: ['application/x-yaml', 'text/yaml', 'text/plain'], category: 'raw_data', previewable: true },
  { extension: 'parquet', mimeTypes: ['application/octet-stream'], category: 'raw_data', previewable: false },
  { extension: 'h5', mimeTypes: ['application/x-hdf5', 'application/octet-stream'], category: 'raw_data', previewable: false },
  { extension: 'hdf5', mimeTypes: ['application/x-hdf5', 'application/octet-stream'], category: 'raw_data', previewable: false },
  { extension: 'mat', mimeTypes: ['application/octet-stream'], category: 'raw_data', previewable: false },

  // Sequencing and molecular biology
  { extension: 'fasta', mimeTypes: ['text/plain', 'application/octet-stream'], category: 'sequence', previewable: true },
  { extension: 'fa', mimeTypes: ['text/plain', 'application/octet-stream'], category: 'sequence', previewable: true },
  { extension: 'fastq', mimeTypes: ['text/plain', 'application/octet-stream'], category: 'sequence', previewable: false },
  { extension: 'fq', mimeTypes: ['text/plain', 'application/octet-stream'], category: 'sequence', previewable: false },
  { extension: 'sam', mimeTypes: ['text/plain', 'application/octet-stream'], category: 'sequence', previewable: false },
  { extension: 'bam', mimeTypes: ['application/octet-stream'], category: 'sequence', previewable: false },
  { extension: 'vcf', mimeTypes: ['text/plain', 'application/octet-stream'], category: 'sequence', previewable: false },
  { extension: 'bed', mimeTypes: ['text/plain'], category: 'sequence', previewable: true },
  { extension: 'gff', mimeTypes: ['text/plain'], category: 'sequence', previewable: false },
  { extension: 'gtf', mimeTypes: ['text/plain'], category: 'sequence', previewable: false },
  { extension: 'ab1', mimeTypes: ['application/octet-stream'], category: 'sequence', previewable: false },

  // Instrument output
  { extension: 'mzml', mimeTypes: ['application/xml', 'application/octet-stream'], category: 'chromatography', previewable: false },
  { extension: 'mzxml', mimeTypes: ['application/xml', 'application/octet-stream'], category: 'chromatography', previewable: false },
  { extension: 'raw', mimeTypes: ['application/octet-stream'], category: 'chromatography', previewable: false },
  { extension: 'cdf', mimeTypes: ['application/octet-stream'], category: 'chromatography', previewable: false },
  { extension: 'fcs', mimeTypes: ['application/octet-stream'], category: 'chromatography', previewable: false },

  // Analysis
  { extension: 'ipynb', mimeTypes: ['application/json', 'text/plain'], category: 'code', previewable: false },
  { extension: 'r', mimeTypes: ['text/plain', 'text/x-r'], category: 'code', previewable: true, forceDownload: true },
  { extension: 'py', mimeTypes: ['text/plain', 'text/x-python'], category: 'code', previewable: true, forceDownload: true },
  { extension: 'sql', mimeTypes: ['text/plain', 'application/sql'], category: 'code', previewable: true, forceDownload: true },

  // Archives
  { extension: 'zip', mimeTypes: ['application/zip', 'application/x-zip-compressed'], category: 'archive', previewable: false },
  { extension: 'gz', mimeTypes: ['application/gzip', 'application/x-gzip'], category: 'archive', previewable: false },
  { extension: 'tar', mimeTypes: ['application/x-tar'], category: 'archive', previewable: false },
  { extension: '7z', mimeTypes: ['application/x-7z-compressed'], category: 'archive', previewable: false },

  // Media
  { extension: 'mp4', mimeTypes: ['video/mp4'], category: 'video', previewable: true },
  { extension: 'webm', mimeTypes: ['video/webm'], category: 'video', previewable: true },
  { extension: 'mov', mimeTypes: ['video/quicktime'], category: 'video', previewable: false },
  { extension: 'avi', mimeTypes: ['video/x-msvideo'], category: 'video', previewable: false },
  { extension: 'mp3', mimeTypes: ['audio/mpeg'], category: 'audio', previewable: true },
  { extension: 'wav', mimeTypes: ['audio/wav', 'audio/x-wav'], category: 'audio', previewable: true },
  { extension: 'ogg', mimeTypes: ['audio/ogg'], category: 'audio', previewable: true },
];

const BY_EXTENSION = new Map(RULES.map((rule) => [rule.extension, rule]));

export const ALLOWED_EXTENSIONS = RULES.map((rule) => rule.extension);

export function findFileTypeRule(extension: string): FileTypeRule | undefined {
  return BY_EXTENSION.get(extension.toLowerCase().replace(/^\./, ''));
}

export function isAllowedExtension(extension: string): boolean {
  return BY_EXTENSION.has(extension.toLowerCase().replace(/^\./, ''));
}

/**
 * The declared MIME type is a hint from the client and is never trusted on its own —
 * the extension decides. A mismatch is reported so the caller can reject an obvious
 * lie (a `.pdf` announced as `application/x-msdownload`) rather than silently accept it.
 */
export function mimeMatchesExtension(extension: string, mimeType: string | undefined): boolean {
  const rule = findFileTypeRule(extension);
  if (!rule) return false;
  if (!mimeType) return true;
  const normalized = mimeType.split(';')[0]!.trim().toLowerCase();
  if (normalized === 'application/octet-stream') return true; // the browser's "I don't know"
  return rule.mimeTypes.includes(normalized);
}

/** Canonical content type to store, chosen from the extension rather than the client. */
export function canonicalMimeType(extension: string): string {
  return findFileTypeRule(extension)?.mimeTypes[0] ?? 'application/octet-stream';
}

export function categoryFor(extension: string): FileCategory {
  return findFileTypeRule(extension)?.category ?? 'other';
}

export function isPreviewable(extension: string): boolean {
  const rule = findFileTypeRule(extension);
  return Boolean(rule?.previewable && !rule.forceDownload);
}

/**
 * Magic-number sniffing for the formats where a mismatch would matter most.
 *
 * Deliberately small: it is a sanity check on the first bytes, not a format library.
 * A file whose extension claims PDF but whose bytes are a Windows executable is
 * rejected; a file we have no signature for is accepted on the extension alone,
 * because it is stored inert and never executed.
 */
const SIGNATURES: Array<{ extensions: string[]; bytes: number[]; offset?: number }> = [
  { extensions: ['pdf'], bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { extensions: ['png'], bytes: [0x89, 0x50, 0x4e, 0x47] },
  { extensions: ['jpg', 'jpeg'], bytes: [0xff, 0xd8, 0xff] },
  { extensions: ['gif'], bytes: [0x47, 0x49, 0x46, 0x38] },
  { extensions: ['zip', 'xlsx', 'docx', 'pptx'], bytes: [0x50, 0x4b, 0x03, 0x04] },
  { extensions: ['gz'], bytes: [0x1f, 0x8b] },
  { extensions: ['7z'], bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
];

/** Byte patterns that must never be stored whatever the extension claims. */
const EXECUTABLE_SIGNATURES: Array<{ label: string; bytes: number[] }> = [
  { label: 'Windows executable', bytes: [0x4d, 0x5a] }, // MZ
  { label: 'Linux ELF binary', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { label: 'macOS Mach-O binary', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
];

function startsWith(head: Buffer, bytes: number[], offset = 0): boolean {
  if (head.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => head[offset + index] === byte);
}

export type SignatureVerdict =
  | { ok: true }
  | { ok: false; reason: string };

export function verifySignature(extension: string, head: Buffer): SignatureVerdict {
  const normalized = extension.toLowerCase();

  for (const executable of EXECUTABLE_SIGNATURES) {
    if (startsWith(head, executable.bytes)) {
      // An archive legitimately containing a binary is fine; a bare one is not.
      return { ok: false, reason: `The file content is a ${executable.label}` };
    }
  }

  const expected = SIGNATURES.find((signature) => signature.extensions.includes(normalized));
  if (!expected) return { ok: true };

  return startsWith(head, expected.bytes, expected.offset)
    ? { ok: true }
    : { ok: false, reason: `The file content does not match a .${normalized} file` };
}
