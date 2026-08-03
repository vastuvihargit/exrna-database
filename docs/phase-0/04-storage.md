# 04 — Local Storage Design & Provider Abstraction

## What "local storage" means here

**Private server-side filesystem.** Not browser `localStorage`, not `public/`, not a CDN origin.
Bytes live on a mounted volume that the web server cannot map to a URL. The only way to obtain a
byte is to call an authenticated API route that checks permissions and streams the file.

## Directory architecture

```
$STORAGE_ROOT (/data in containers, e.g. /var/lib/biotech-drive on the host)
├── storage/
│   ├── originals/      {organizationId}/{departmentId}/{fileId}/{versionId}
│   ├── versions/       {fileId}/{versionId}                 # non-primary-department versions & legacy
│   ├── previews/       {fileId}/{versionId}[.pdf|.png|.txt]
│   ├── quarantine/     {uploadSessionId}/{part-000001 … , assembled}
│   ├── migration-staging/ {migrationJobId}/{migrationItemId}
│   ├── temporary/      {uploadSessionId}/…                  # chunk scratch
│   ├── exports/        {userId}/{exportJobId}.zip
│   └── archives/       {organizationId}/{yyyy}/{fileId}/{versionId}
└── backups/            (written by the backup container, never by the app)
```

Env mapping (all configurable, validated at boot):

```env
LOCAL_STORAGE_ROOT=/data/storage
TEMP_UPLOAD_ROOT=/data/temp
QUARANTINE_ROOT=/data/quarantine
PREVIEW_ROOT=/data/previews
EXPORT_ROOT=/data/exports
BACKUP_ROOT=/data/backups
MAX_UPLOAD_SIZE_MB=2048
```

> The env vars name *roots per purpose*; the tree above names *logical areas*. The provider maps
> `area → root` (`originals|versions|archives|migration-staging → LOCAL_STORAGE_ROOT`,
> `quarantine → QUARANTINE_ROOT`, `previews → PREVIEW_ROOT`, `temporary → TEMP_UPLOAD_ROOT`,
> `exports → EXPORT_ROOT`) so the two views stay consistent whether the deployment uses one volume
> or five.

### Naming

- Physical name = **UUIDv4** (`versionId` / a generated UUID), never the user's filename.
- Original filename lives only in MongoDB (`originalFilename`) and is re-attached at download time
  via a sanitized `Content-Disposition`.
- Extension is *not* appended to the stored name for originals (prevents any handler from ever
  deciding to execute it); previews keep an extension because they are generated, safe artifacts.
- A storage key is **relative**: `originals/652f…/6530…/6531…/6532…`. Absolute paths never leave
  the provider.

## Hard rules (brief §3, made concrete)

| # | Rule | Mechanism |
|---|---|---|
| 1 | Files outside the public web directory | Roots are `/data/**`; `public/` contains only static UI assets. A boot assertion fails if any root resolves inside the app directory or `public/`. |
| 2 | Never expose physical paths | DTO mappers omit `storageKey`/`relativeStoragePath`; a serializer test asserts no response body matches `/^\/(data\|var)\//` or contains `storageKey`. Logger redacts them. |
| 3 | No `/uploads/x.pdf` style access | Nginx has no `location /data`; Next.js serves nothing from those roots; only `/api/files/:id/download|preview` return bytes. |
| 4 | All reads through the backend | Same as 3. |
| 5 | Authenticated user validated first | `getActor()` before any provider call, in the route handler. |
| 6 | File- and folder-level permission checks | `assertCan(actor,'file.download',file)` walks the folder chain. |
| 7 | Directory traversal prevention | `resolveKey()` below. |
| 8 | Normalize & validate every path | Same function; used by **all** provider methods, including delete and move. |
| 9 | Never trust a client filename | `sanitizeFilename()`: strips path separators, control chars, RTL overrides, leading dots, Windows reserved names, truncates to 255 UTF-8 bytes; result is used for *display only*. |
| 10 | Generated storage names | UUID. |
| 11 | SHA-256 | Computed streaming, during the write, not in a second pass. |
| 12 | Size + MIME recorded | `fileSize` from the stream counter (not the client), `mimeType` from magic-byte sniffing. |
| 13 | Block executables | Extension deny-list + MIME deny-list + "declared vs sniffed" mismatch rejection. |
| 14 | Never execute uploads | No `exec`/`spawn` on stored paths; volume mounted `noexec` where the OS permits; files written `0640`. |
| 15 | Never overwrite a version | `open(..., 'wx')` — exclusive create; `EEXIST` is a hard error. Provider has no overwrite mode. |
| 16 | Persistent Docker volumes | Named volumes / host bind mounts, declared in compose. |
| 17 | Backup & restore procedures | [09](./09-deployment-and-backup.md). |
| 18 | Usage tracked by user/dept/project | `storageUsage` collection + incremental counters. |
| 19 | Configurable upload limits | `MAX_UPLOAD_SIZE_MB`, per-org override, per-user quota, per-department quota. |
| 20 | Swappable provider | `StorageProvider` interface below. |

### The one function that prevents traversal

```ts
// src/server/storage/path-safety.ts
const KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertSafeKey(key: string): void {
  if (!key || key.length > 1024) throw new StorageError('INVALID_KEY');
  if (key.includes('\0')) throw new StorageError('INVALID_KEY');
  if (path.isAbsolute(key) || /^[A-Za-z]:/.test(key)) throw new StorageError('INVALID_KEY');
  const segments = key.split('/');
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..') throw new StorageError('INVALID_KEY');
    if (!KEY_SEGMENT.test(s)) throw new StorageError('INVALID_KEY');
  }
}

export function resolveKey(root: string, key: string): string {
  assertSafeKey(key);
  const resolvedRoot = path.resolve(root) + path.sep;
  const full = path.resolve(root, key);
  if (!full.startsWith(resolvedRoot)) throw new StorageError('PATH_ESCAPE');  // defence in depth
  return full;
}
```

Allow-list, not deny-list: `..`, `%2e%2e`, `....//`, absolute paths, UNC paths, NUL bytes, unicode
separators and symlink-ish names all fail the segment regex. After open, the provider additionally
`fstat`s and rejects non-regular files (symlink/FIFO/device) — closing the
"replace-the-file-with-a-symlink between resolve and open" race.

## StorageProvider abstraction

```ts
// src/server/storage/types.ts  — framework-free, no Next/Mongoose imports
export type StorageArea =
  | 'originals' | 'versions' | 'previews' | 'quarantine'
  | 'migration-staging' | 'temporary' | 'exports' | 'archives';

export interface SaveFileInput {
  key: string;                        // relative, caller-generated, validated by the provider
  area: StorageArea;
  body: NodeJS.ReadableStream;
  expectedSize?: number;              // hard-fail if the stream exceeds it
  contentType?: string;
  overwrite?: false;                  // literal false — the type forbids overwriting
}

export interface StoredFile {
  key: string;
  area: StorageArea;
  size: number;                       // measured, not declared
  checksumSha256: string;             // computed during the write
  storedAt: Date;
}

export interface StoredFileMetadata {
  key: string; size: number; contentType?: string;
  createdAt: Date; modifiedAt: Date; etag?: string;
}

export interface GetFileOptions { range?: { start: number; end?: number } }

export interface StorageProvider {
  readonly name: 'local' | 's3' | 'minio' | 'r2';
  saveFile(input: SaveFileInput): Promise<StoredFile>;
  getFile(fileKey: string, options?: GetFileOptions): Promise<NodeJS.ReadableStream>;
  deleteFile(fileKey: string): Promise<void>;
  fileExists(fileKey: string): Promise<boolean>;
  moveFile(sourceKey: string, destinationKey: string): Promise<void>;
  copyFile(sourceKey: string, destinationKey: string): Promise<void>;
  getFileMetadata(fileKey: string): Promise<StoredFileMetadata>;
  createWriteStream(key: string, area: StorageArea): Promise<StorageWriteHandle>; // chunked uploads
  getCapacity(): Promise<{ totalBytes: number; freeBytes: number }>;              // health check
}
```

The brief's six-method interface is the core; the extra four (`copyFile`, `createWriteStream`,
`getCapacity`, and the `range` option) are required by features the brief also mandates —
file copy, resumable chunked upload, health reporting, and video Range requests. They are all
implementable on S3 (`CopyObject`, multipart upload, no-op capacity, ranged `GetObject`), so the
abstraction stays portable.

### `LocalStorageProvider` behaviour

| Method | Implementation notes |
|---|---|
| `saveFile` | `mkdir -p` parent; `createWriteStream(full, {flags:'wx', mode:0o640})`; pipeline `body → sizeCounter → sha256 → file`; abort + unlink if `expectedSize` exceeded or stream errors; `fsync` the file **and its parent directory** before resolving (a crash must not leave a Mongo row pointing at unflushed bytes). |
| `getFile` | `resolveKey` → `open` → `fstat` (must be a regular file) → `createReadStream({start,end})`. |
| `deleteFile` | `resolveKey` → `unlink`; `ENOENT` is idempotent success. Callers only delete quarantine/temp/preview/purged content. |
| `moveFile` | `rename` when same device (the quarantine→originals hot path); falls back to copy+fsync+unlink across devices. Destination must not exist. |
| `copyFile` | `copyFile(src,dst,COPYFILE_EXCL)`. |
| `createWriteStream` | Returns `{ write(chunk), commit(): Promise<StoredFile>, abort() }` used by chunk assembly. |
| `getCapacity` | `statfs` on the root. |

Providers are resolved once through `getStorageProvider(area)`; no module outside
`src/server/storage/**` imports `fs`. An ESLint rule enforces that.

## Storage key generation

```ts
buildOriginalKey({organizationId, departmentId, fileId, versionId})
  → `originals/${organizationId}/${departmentId ?? 'no-department'}/${fileId}/${versionId}`
buildVersionKey({fileId, versionId})            → `versions/${fileId}/${versionId}`
buildPreviewKey({fileId, versionId, ext})       → `previews/${fileId}/${versionId}.${ext}`
buildQuarantineKey({uploadSessionId, part?})    → `quarantine/${uploadSessionId}/${part ?? 'assembled'}`
buildMigrationKey({migrationJobId, itemId})     → `migration-staging/${migrationJobId}/${itemId}`
buildExportKey({userId, exportJobId})           → `exports/${userId}/${exportJobId}.zip`
buildArchiveKey({organizationId, year, fileId, versionId})
  → `archives/${organizationId}/${year}/${fileId}/${versionId}`
```

All inputs are ObjectId hex strings or UUIDs — they cannot contain a separator, so keys are
structurally safe before `assertSafeKey` even runs.

## File-type policy

**Allowed by default** (org-configurable): documents (`pdf docx xlsx pptx doc xls ppt odt ods txt md rtf csv tsv json xml yaml`),
images (`png jpg jpeg gif webp tiff bmp svg*`), archives (`zip tar gz 7z`), media (`mp4 webm mov mp3 wav`),
research/instrument (`fastq fasta fa gb ab1 mzml raw cdf nd2 czi lif dm3 h5 hdf5 mat sav xpt jdx sdf mol pdb cif`),
notebooks/code (`ipynb r py m sql`).

**Blocked**: `exe dll com bat cmd sh bash ps1 psm1 vbs js jse wsf wsh scr msi msix jar apk app pkg dmg deb rpm cgi php phtml asp aspx jsp htaccess lnk reg iso`.

Notes:
- `svg` is stored but **never** previewed inline as `image/svg+xml`; it is served
  `Content-Type: application/octet-stream` with `Content-Disposition: attachment`, or rasterized —
  SVG is script-capable and would otherwise be stored XSS.
- `zip` is accepted as an opaque blob; the MVP never extracts archives (zip-slip risk).
- `html`/`htm` are stored but only ever downloaded, never previewed.
- Every served byte carries `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`,
  and (for previews) a restrictive CSP with `default-src 'none'`.

**Validation order at upload:** extension allow/deny → declared MIME allow/deny → size vs limits and
quota → *stream to quarantine* → magic-byte sniff of the real content → mismatch check
(e.g. `.pdf` whose bytes are `MZ`) → checksum → promote. Sniffing happens **after** the bytes land in
quarantine because you cannot trust anything before you have the actual bytes.

## Integrity, quotas, lifecycle

- **Checksums** — computed on write; a weekly worker re-hashes a rolling sample (and every version
  younger than 30 days) and raises a `storage.integrity_failed` alert + audit row on mismatch.
- **Orphan detection** — nightly: keys on disk with no `fileVersions` row (report only, never
  auto-delete), and `fileVersions` rows whose key is missing on disk (alert immediately — this is
  data loss).
- **Quota enforcement** — checked at *authorization* time (declared size) and again at *finalize*
  time (measured size). Exceeding at finalize discards the quarantine file and fails the session.
- **Trash → purge** — `TRASH_RETENTION_DAYS=30`; purge deletes bytes for all versions of the file,
  writes one audit row per version, and keeps the audit trail forever.
- **Abandoned uploads** — TTL index expires `uploadSessions`; a sweeper removes matching quarantine
  and temp directories older than `INCOMPLETE_UPLOAD_RETENTION_HOURS`.
- **Archive** — archived files may be moved from `originals/` to `archives/{year}/` by a job that
  updates `storageKey` inside a transaction; the version stays immutable in every other respect.

## Filesystem permissions

Container runs as non-root `node` (uid 1000). Volumes owned `1000:1000`, directories `0750`,
files `0640`. The Nginx container never mounts `/data`. The backup container mounts it **read-only**.
