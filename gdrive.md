Act as a senior full-stack architect, MongoDB engineer, Google Drive API specialist, migration engineer, security expert, and UI/UX developer.

We already have a working Google Drive–like biotech R&D platform built with:

* Next.js
* TypeScript
* MongoDB
* Mongoose
* Local server file storage
* Role-based permissions
* Folders and files
* Uploads and downloads
* File previews
* Search
* Research metadata
* File versioning
* Reviews and approvals
* Audit logs
* Recent, Starred and Trash
* Admin features

Do **not** rebuild the project.

We now need to carefully change the storage architecture from:

```text
MongoDB metadata + local server file storage
```

to:

```text
MongoDB metadata + Google Shared Drive file storage
```

MongoDB must remain the main application database.

Google Shared Drive must store the actual file binaries and folders.

The final application must remain easy to use like Google Drive for non-technical employees.

---

# Primary Objective

Refactor the existing project so that:

* Existing MongoDB models and application logic are preserved where possible.
* Existing local files can be migrated safely to Google Shared Drive.
* New uploads are stored in Google Shared Drive.
* MongoDB stores Google Drive file IDs and structured research metadata.
* Existing UI and API behavior remains stable.
* Users do not need to understand Google Drive, APIs, storage providers or synchronization.
* No existing file, metadata record, approval, comment, permission or audit history is lost.

Do not create a new project.

Do not rewrite working modules unnecessarily.

Do not remove the current local-storage implementation immediately.

Implement a safe, reversible, phase-wise migration.

---

# 1. First Analyze the Existing Project

Before making changes, deeply analyze the complete codebase.

Inspect:

* Current project structure.
* MongoDB schemas.
* File model.
* Folder model.
* File-version model.
* Upload-session model.
* Current local-storage service.
* Upload API routes.
* Download API routes.
* Preview APIs.
* Folder creation.
* Rename.
* Move.
* Copy.
* Trash.
* Restore.
* File versioning.
* Search.
* Recent and Starred.
* Permissions.
* Reviews and approvals.
* Audit logs.
* Background jobs.
* Docker volumes.
* Environment configuration.
* Tests.
* Admin settings.

Then provide:

1. Current storage architecture.
2. Exact places where local-storage paths are used.
3. Exact files that need modification.
4. Features that can remain unchanged.
5. MongoDB schema changes required.
6. API routes affected.
7. Main migration risks.
8. Rollback plan.
9. Phase-wise implementation plan.
10. Acceptance criteria for every phase.

Do not start changing code before completing this analysis.

---

# 2. Important Architecture Decision

Keep MongoDB as the main application database.

MongoDB continues storing:

* Users.
* Company email accounts.
* Departments.
* Roles.
* Permissions.
* Projects.
* Experiments.
* Folder metadata.
* File metadata.
* File-version metadata.
* Research metadata.
* Sample IDs.
* Protocol references.
* Tags.
* Comments.
* Shares.
* Reviews.
* Approvals.
* Notifications.
* Recent activity.
* Starred items.
* Trash state.
* Audit logs.
* Migration jobs.
* Synchronization jobs.
* Google Drive file IDs.

Google Shared Drive stores:

* Actual files.
* Actual file versions where supported.
* Google Docs.
* Google Sheets.
* Google Slides.
* PDFs.
* Images.
* Videos.
* ZIP files.
* Raw research datasets.
* Reports.
* Other uploaded binaries.

Do not store files inside MongoDB.

Do not store files as Base64.

Do not migrate application metadata out of MongoDB.

---

# 3. Google Shared Drive Requirement

Use a company-owned Google Shared Drive.

Do not use an employee’s personal My Drive as permanent company storage.

Add environment configuration:

```env
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=

GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=

GOOGLE_WORKSPACE_DOMAIN=company.com
GOOGLE_SHARED_DRIVE_ID=
GOOGLE_ROOT_FOLDER_ID=

GOOGLE_DRIVE_STORAGE_ENABLED=false
DEFAULT_STORAGE_PROVIDER=local
```

During the migration, support:

```text
DEFAULT_STORAGE_PROVIDER=local
DEFAULT_STORAGE_PROVIDER=google_drive
```

Never expose Google credentials or access tokens to the frontend.

Select the most suitable authentication method after examining the project:

* Service account with access to the Shared Drive.
* Google Workspace domain-wide delegation.
* Admin-authorized OAuth connection.

Explain the selected method and its security implications.

---

# 4. Create a Storage Provider Abstraction

The current application probably calls local filesystem functions directly.

Refactor those calls behind a common interface.

Create or adapt an interface such as:

```ts
interface StorageProvider {
  uploadFile(input: UploadFileInput): Promise<StoredFileResult>;
  downloadFile(storageId: string): Promise<ReadableStream>;
  getFileMetadata(storageId: string): Promise<StorageFileMetadata>;
  createFolder(input: CreateStorageFolderInput): Promise<StoredFolderResult>;
  renameItem(storageId: string, name: string): Promise<void>;
  moveItem(storageId: string, parentStorageId: string): Promise<void>;
  trashItem(storageId: string): Promise<void>;
  restoreItem(storageId: string): Promise<void>;
  deleteItem(storageId: string): Promise<void>;
  copyItem(storageId: string, targetParentId: string): Promise<StoredFileResult>;
  fileExists(storageId: string): Promise<boolean>;
}
```

Implement:

```text
LocalStorageProvider
GoogleDriveStorageProvider
```

Requirements:

* Existing local storage must continue working.
* Do not duplicate permission logic inside storage providers.
* Application services should decide whether the user is authorized.
* Storage providers should perform storage-specific operations only.
* Do not scatter Google Drive API calls throughout API routes.
* Use one centralized Google Drive client.
* Make provider operations testable and mockable.

---

# 5. Preserve Existing Application IDs

Do not replace MongoDB file and folder IDs with Google Drive IDs.

The application should continue using MongoDB `_id` values in:

* URLs.
* API requests.
* Permissions.
* Comments.
* Reviews.
* Approvals.
* Search results.
* Related records.
* Audit logs.

Store the external storage identifier separately.

Example file record:

```ts
{
  _id: ObjectId,

  name: string,
  folderId: ObjectId,

  storageProvider: "local" | "google_drive",

  localStorageKey?: string,

  googleDriveFileId?: string,
  googleDriveParentId?: string,
  googleDriveRevisionId?: string,
  googleDriveWebViewLink?: string,

  mimeType: string,
  size: number,
  checksum: string,

  projectId?: ObjectId,
  experimentId?: ObjectId,
  departmentId?: ObjectId,

  migrationStatus:
    | "not_started"
    | "queued"
    | "uploading"
    | "uploaded"
    | "verifying"
    | "verified"
    | "failed"
    | "rolled_back",

  syncStatus:
    | "not_required"
    | "pending"
    | "synced"
    | "failed"
    | "conflict",

  lastSyncedAt?: Date
}
```

Use sparse and partial indexes for Google Drive fields.

Required indexes should include:

* Unique Google Drive file ID per storage connection.
* `storageProvider`.
* `migrationStatus`.
* `syncStatus`.
* `folderId`.
* `projectId`.
* `departmentId`.
* Existing search fields.

Do not break existing MongoDB records that do not yet contain Google Drive fields.

---

# 6. Dual-Storage Transition

The system must temporarily support both:

* Existing files stored locally.
* Migrated or newly uploaded files stored in Google Drive.

Every file operation must resolve the correct storage provider from the file record.

Example:

```ts
const provider = storageProviderRegistry.get(file.storageProvider);
```

The system must support:

```text
Old file → local provider
Migrated file → Google Drive provider
New file → configured default provider
```

Do not switch all records to Google Drive before their files are verified.

Do not delete the local copy immediately after migration.

---

# 7. Existing Local File Migration

Build a controlled migration process for existing local files.

Migration flow:

```text
Read MongoDB file record
        ↓
Locate local file safely
        ↓
Verify local file exists
        ↓
Calculate or verify checksum
        ↓
Create required folder in Shared Drive
        ↓
Upload file to Google Drive
        ↓
Receive Google Drive file ID
        ↓
Fetch uploaded file metadata
        ↓
Verify name, size and checksum where possible
        ↓
Update MongoDB storage fields
        ↓
Mark migration as verified
        ↓
Keep local copy temporarily
```

Migration requirements:

* Process files in controlled batches.
* Support pause and resume.
* Support retry.
* Record failure reason.
* Prevent duplicate uploads.
* Make jobs idempotent.
* Do not create a second Drive file when retrying a completed operation.
* Store migration job and migration item records.
* Generate progress reports.
* Support migration by:

  * Folder.
  * Department.
  * Project.
  * File type.
  * Date range.
  * Selected files.
* Include dry-run mode.
* Include verification-only mode.
* Include rollback mode.

Migration statuses:

* Not started.
* Queued.
* Uploading.
* Uploaded.
* Verifying.
* Verified.
* Failed.
* Rolled back.

Admin migration dashboard should show:

* Total selected files.
* Total size.
* Completed files.
* Verified files.
* Failed files.
* Skipped files.
* Remaining files.
* Current transfer speed.
* Failure reasons.
* Retry action.

---

# 8. Folder Mapping

Existing application folders probably use MongoDB IDs and local directory paths.

Do not expose or replace MongoDB folder IDs.

Create mapping fields:

```ts
{
  _id: ObjectId,
  name: string,
  parentFolderId?: ObjectId,

  storageProvider: "local" | "google_drive",

  googleDriveFolderId?: string,
  googleDriveParentFolderId?: string,

  migrationStatus: string,
  syncStatus: string
}
```

During migration:

1. Create the equivalent folder structure in Google Shared Drive.
2. Preserve parent-child relationships.
3. Save the Google Drive folder IDs.
4. Reuse existing Drive folders when a verified mapping already exists.
5. Prevent duplicate folder creation.
6. Do not match folders by name alone.
7. Store a permanent mapping between MongoDB folders and Drive folders.

The MongoDB hierarchy remains the application hierarchy.

Google Drive should mirror it.

---

# 9. New Upload Flow

After Google Drive storage is enabled, new uploads should follow this flow:

```text
User selects file
        ↓
Existing frontend upload tray
        ↓
Backend authentication
        ↓
Existing permission validation
        ↓
Existing file-type and size validation
        ↓
Create upload session
        ↓
Upload to Google Shared Drive
        ↓
Save Google Drive file ID
        ↓
Save MongoDB metadata
        ↓
Save research metadata
        ↓
Create audit log
        ↓
Refresh existing UI
```

Requirements:

* Reuse the current upload tray.
* Preserve progress, retry and cancellation.
* Use Google Drive resumable uploads for large files.
* Do not load complete large files into memory.
* Keep user-facing messages simple.
* Do not show Google API terminology.
* Preserve folder upload.
* Preserve multi-file upload.
* Preserve version notes.
* Preserve research metadata entry.

User-facing statuses:

* Preparing.
* Uploading.
* Saving.
* Complete.
* Upload failed.
* Try again.

---

# 10. Preview and Download

Refactor the existing preview and download APIs to use the storage provider.

Do not redesign the frontend unless required.

Preview flow:

1. Receive MongoDB file ID.
2. Authenticate user.
3. Check existing permissions.
4. Load MongoDB file record.
5. Resolve its storage provider.
6. Stream or export the file.
7. Create existing activity and audit logs.

Download flow:

1. Receive MongoDB file ID and optional version ID.
2. Authenticate user.
3. Check download permission.
4. Resolve provider.
5. Stream file securely.
6. Use the original safe filename.
7. Record download history.

Do not:

* Send Google tokens to the browser.
* Return physical local paths.
* Return Drive credentials.
* Let the browser access the Drive API directly.
* Bypass MongoDB permission checks.

---

# 11. Google-Native Files

Support:

* Google Docs.
* Google Sheets.
* Google Slides.

For Google-native files:

* Store their Drive file IDs in MongoDB.
* Show recognizable document icons.
* Allow authorized users to open the native Google editor.
* Allow export to supported formats where practical.
* Record application access.
* Clearly distinguish native Google files from uploaded binary files.

Approval rules:

* Approval must remain tied to an exact known state.
* Store the Drive revision ID or modified timestamp.
* Detect changes after approval.
* If an approved Google-native file changes, mark it as requiring review again.
* Do not silently keep the old approval status.

---

# 12. Existing Search Must Remain MongoDB-Based

Do not replace the existing application search with live Drive search.

Continue using MongoDB for:

* Filename search.
* Folder search.
* Project search.
* Experiment search.
* Sample ID search.
* Research tags.
* Metadata filters.
* Recent items.
* Starred items.
* Review status.
* Approval status.
* Permission filtering.

The Google Drive API should not be called every time a user opens:

* My Drive.
* Recent.
* Starred.
* Search.
* Project Drive.
* Department Drive.

Google Drive should be used for actual storage operations and synchronization.

Preserve all existing search permission checks.

---

# 13. Existing Permissions Remain Authoritative

Keep the current MongoDB permission model.

Google Workspace controls who can authenticate.

MongoDB controls what an employee may do inside the application.

Do not replace application permissions with Google Drive sharing permissions.

Before every Google Drive operation, validate existing permissions for:

* View.
* Preview.
* Download.
* Upload.
* Rename.
* Move.
* Copy.
* Trash.
* Restore.
* Review.
* Approve.
* Manage access.

Google Drive credentials should operate through the backend.

Employees should not require direct access to every underlying Shared Drive file unless the product intentionally supports it.

---

# 14. Versioning

Preserve the current versioning architecture.

Each MongoDB file version should support:

```ts
{
  _id: ObjectId,
  fileId: ObjectId,
  versionNumber: number,

  storageProvider: "local" | "google_drive",

  localStorageKey?: string,

  googleDriveFileId?: string,
  googleDriveRevisionId?: string,

  checksum: string,
  size: number,
  mimeType: string,

  versionNote?: string,
  uploadedBy: ObjectId,
  uploadedAt: Date,

  reviewStatus: string,
  approvalStatus: string
}
```

Requirements:

* Do not lose old version records.
* Do not detach approvals from versions.
* Preserve checksums.
* Preserve version notes.
* Preserve uploader information.
* Preserve approval history.
* Never silently overwrite an approved version.
* Support versions stored across different providers during the migration.

---

# 15. Synchronization

The application remains the main interface, but changes may also happen directly in Google Drive.

Implement Google Drive change synchronization after the storage migration works.

Use the Drive Changes API.

Store synchronization cursors in MongoDB.

Synchronize:

* New items.
* Renames.
* Moves.
* Trash.
* Restore.
* Modified files.
* Google-native document changes.
* Relevant permission changes.

Synchronization requirements:

* Idempotent.
* Retry-safe.
* Logged.
* Recoverable.
* Able to handle expired change tokens.
* Able to run manually.
* Able to run on a schedule.
* Able to report conflicts.

Do not implement synchronization before the basic provider, migration, preview, download and upload flows are stable.

---

# 16. Conflict Handling

Define clear conflict rules.

Examples:

### Local metadata changed while migration runs

* Preserve the newest MongoDB metadata.
* Do not overwrite project, experiment, tags or approval status with Drive metadata.

### File uploaded successfully but MongoDB update fails

* Record a recovery item.
* Do not report complete success to the user.
* Reconcile using the Drive file ID or upload identifier.
* Avoid duplicate re-upload.

### MongoDB updated but Drive operation fails

* Roll back or mark the record as failed.
* Do not show the operation as complete.
* Preserve the original state.

### File changed directly in Google Drive

* Update storage metadata.
* Preserve application research metadata.
* Mark approved files for review when content changes.

### Drive file missing

* Do not silently remove the MongoDB record.
* Mark the storage state as missing.
* Notify an administrator.
* Preserve audit history.

---

# 17. Audit Logs

Preserve the existing audit system.

Add actions for:

* Storage provider changed.
* Migration queued.
* Migration started.
* Migration completed.
* Migration failed.
* Migration retried.
* Migration rolled back.
* Drive connection established.
* Drive connection failed.
* Sync started.
* Sync completed.
* Sync conflict.
* Drive file missing.
* Local copy archived.
* Local copy deleted.

Every migration audit entry should contain:

* File MongoDB ID.
* User or system actor.
* Previous provider.
* New provider.
* Drive file ID internally.
* Migration job ID.
* Timestamp.
* Failure reason where applicable.
* Checksum verification result.

Do not expose sensitive Drive IDs or credentials in the normal employee interface.

---

# 18. Local Copy Retention

Do not delete local files immediately.

After successful verification:

1. Mark the Google Drive copy as verified.
2. Continue serving from Google Drive.
3. Retain the local file for a configurable safety period.
4. Run production verification.
5. Take a backup.
6. Archive or delete local copies only after explicit admin approval.

Add configuration:

```env
LOCAL_COPY_RETENTION_DAYS=30
DELETE_LOCAL_AFTER_MIGRATION=false
```

Default:

```text
DELETE_LOCAL_AFTER_MIGRATION=false
```

Deletion must be a separate admin-controlled action.

---

# 19. User Experience Rules

The migration must be invisible or simple for normal employees.

Keep the existing Drive-style interface.

Do not show:

* Storage provider.
* Google file ID.
* MongoDB ID.
* Migration status.
* Sync cursor.
* OAuth scope.
* API quota.
* Revision identifiers.
* Local storage key.
* Checksum.

Normal employees should continue seeing:

* File name.
* Folder.
* Owner.
* Modified time.
* Project.
* Experiment.
* Tags.
* Approval status.
* Version history.
* Preview.
* Download.
* Share.
* Move.
* Rename.
* Trash.
* Restore.

Technical migration information should only appear in the admin area.

---

# 20. Phase-Wise Implementation Plan

## Phase 0 — Complete Audit and Migration Design

Do not change production code yet.

Provide:

* Current local-storage architecture.
* Affected files.
* Current MongoDB models.
* Storage-provider design.
* Schema changes.
* Google Drive authentication design.
* Folder-mapping design.
* Local-file migration flow.
* Rollback strategy.
* Risk assessment.
* Test plan.
* Phase acceptance criteria.

Stop after producing the analysis.

---

## Phase 1 — Storage Provider Abstraction

Implement:

* StorageProvider interface.
* Provider registry.
* LocalStorageProvider using existing functionality.
* Refactor current file operations to use LocalStorageProvider.
* Unit tests.

Do not connect Google Drive to production flows yet.

Acceptance criteria:

* Existing local-storage behavior remains unchanged.
* Current uploads, previews and downloads still work.
* Existing tests pass.
* No UI regression occurs.

---

## Phase 2 — Google Drive Provider

Implement:

* Secure Google API client.
* GoogleDriveStorageProvider.
* Shared Drive connection.
* Health-check endpoint.
* Admin connection status.
* Unit and integration tests.

Acceptance criteria:

* Backend can connect to the Shared Drive.
* Create, upload, stream, rename, move, Trash and restore work in a test folder.
* No credentials reach the frontend.
* Existing local provider still works.

---

## Phase 3 — MongoDB Schema Extension

Add:

* Storage provider fields.
* Google Drive file IDs.
* Google Drive folder IDs.
* Migration statuses.
* Sync statuses.
* Revision identifiers.
* Migration job models.
* Migration item models.
* Required indexes.
* Backward-compatible database migration.

Acceptance criteria:

* Existing records remain valid.
* Local files still work.
* No existing approval or version relationship is broken.
* Index creation succeeds.

---

## Phase 4 — Dual-Storage Read Support

Update:

* Preview.
* Download.
* File metadata.
* File-version access.
* Folder access.

Resolve provider per record.

Acceptance criteria:

* Local files still open.
* Test Drive files open.
* Permission validation remains unchanged.
* API response shapes remain stable.

---

## Phase 5 — Migration Tool

Build:

* Dry-run mode.
* Batch migration.
* Folder mapping.
* Checksum verification.
* Retry.
* Pause and resume.
* Failure reporting.
* Admin dashboard.
* Rollback support.
* Local-copy retention.

Acceptance criteria:

* A test project migrates without data loss.
* Duplicate retries do not duplicate Drive files.
* Failed files remain local.
* Verified files open from Drive.
* Existing metadata and approvals remain intact.

---

## Phase 6 — New Uploads to Google Drive

Update:

* Normal upload.
* Multiple upload.
* Folder upload.
* Resumable upload.
* New file version upload.
* Upload progress.
* Retry.

Use Google Drive as the selected default provider.

Acceptance criteria:

* New uploads appear in Drive and MongoDB.
* Upload tray remains functional.
* Large files use resumable upload.
* Failed uploads are recoverable.
* Existing local files remain accessible.

---

## Phase 7 — File and Folder Mutations

Connect Google Drive operations for:

* Create folder.
* Rename.
* Move.
* Copy.
* Trash.
* Restore.

Acceptance criteria:

* Google Drive and MongoDB remain consistent.
* Failed operations do not appear successful.
* Existing user experience remains unchanged.
* Audit logs are created.

---

## Phase 8 — Versioning and Approvals

Connect:

* Drive revisions.
* MongoDB file versions.
* Version notes.
* Approval checksums.
* Google-native document change detection.

Acceptance criteria:

* Existing approvals remain valid.
* Approval is tied to a specific version.
* Changed approved documents return to review.
* Old versions remain accessible.

---

## Phase 9 — Incremental Synchronization

Implement:

* Drive Changes API.
* Sync cursors.
* Scheduled synchronization.
* Manual synchronization.
* Conflict handling.
* Reconciliation.
* Admin monitoring.

Acceptance criteria:

* Direct Drive changes appear in the application.
* No duplicate metadata records are created.
* Sync failures are visible and retryable.
* Approved changes trigger review correctly.

---

## Phase 10 — Production Migration

Perform migration in controlled groups:

1. Internal test folder.
2. Test department.
3. Small project.
4. Selected active projects.
5. Remaining active files.
6. Archive files.

Do not migrate all files in one uncontrolled operation.

Acceptance criteria:

* Every batch has a report.
* Failed items remain accessible locally.
* Local backups exist.
* Rollback is tested.
* Employees can continue working.

---

## Phase 11 — Cleanup

Only after production verification:

* Archive local files.
* Remove obsolete direct filesystem calls.
* Keep LocalStorageProvider for rollback or future use.
* Update documentation.
* Update backup strategy.
* Remove unused environment variables only after verification.

Do not delete local files automatically.

---

# 21. Required Tests

Add tests for:

* Local provider.
* Google Drive provider.
* Provider resolution.
* Backward-compatible MongoDB models.
* Folder mapping.
* Dry-run migration.
* Successful migration.
* Failed migration.
* Migration retry.
* Duplicate prevention.
* Checksum verification.
* Rollback.
* Preview from both providers.
* Download from both providers.
* Upload to Drive.
* Large resumable upload.
* Rename.
* Move.
* Trash.
* Restore.
* File versions.
* Approval after content modification.
* Permission enforcement.
* ID guessing.
* Search permission leakage.
* Partial Google API failure.
* MongoDB failure after Drive success.
* Drive failure after MongoDB preparation.
* Expired synchronization token.

Run after every phase:

* Type checking.
* Linting.
* Unit tests.
* Integration tests.
* Relevant end-to-end tests.
* Production build.

---

# 22. Completion Report for Every Phase

At the end of each phase, report:

1. Files inspected.
2. Files changed.
3. Architecture changes.
4. Database changes.
5. Tests added.
6. Commands run.
7. Test results.
8. Build result.
9. Remaining risks.
10. Manual verification steps.
11. Rollback instructions.
12. Acceptance-criteria status.

Do not automatically start the next phase when critical failures remain.

---

# Final Instruction

This is an **existing working application migration**, not a fresh implementation.

The correct strategy is:

```text
Preserve existing MongoDB application data
        ↓
Introduce storage-provider abstraction
        ↓
Keep local storage working
        ↓
Add Google Drive provider
        ↓
Support both providers
        ↓
Migrate files in controlled batches
        ↓
Verify every file
        ↓
Move new uploads to Google Drive
        ↓
Keep local copies temporarily
        ↓
Enable synchronization
```

Do not rebuild working UI, permissions, search, approvals or audit features.

Start with Phase 0 analysis only.

After Phase 0, implement Phase 1 only.

Keep the application easy for non-technical employees and ensure no existing data or functionality is lost.
