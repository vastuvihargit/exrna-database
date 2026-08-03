# Build a Biotech Research Drive Using MongoDB and Local Server Storage

Act as a senior full-stack developer, system architect, MongoDB database engineer, UI/UX designer, cybersecurity specialist, DevOps engineer, and biotech research data-management expert.

Design and build a secure, company-internal **Biotech Research Drive**—a private Google Drive–like web platform where authorized employees can upload, organize, preview, search, share, review, version, and manage all company R&D data in one place.

The system must remain simple and familiar like Google Drive while adding biotech-specific organization, projects, experiments, research metadata, approval workflows, file versioning, permissions, and complete audit history.

---

# 1. Main Business Problem

We currently use Google Drive, but employees face problems such as:

* Difficulty finding the correct file.
* Not knowing where a document is stored.
* Duplicate files in different folders.
* Difficulty identifying the latest approved version.
* No clear connection between files, projects, experiments, samples, and results.
* Inconsistent file and folder naming.
* Difficulty tracking who uploaded, moved, downloaded, edited, or approved a file.
* Difficulty controlling confidential R&D information.
* Difficulty searching old research data.
* Difficulty understanding the complete history of a research project.

The new platform must make research data easier to organize and discover.

The primary user workflow must remain:

**Create folder → Upload files → Organize → Search → Preview → Share → Review → Track versions**

Do not turn the MVP into an unnecessarily complex laboratory management system.

---

# 2. Mandatory Technical Stack

Use the following architecture.

## Frontend

* Next.js App Router.
* TypeScript.
* Tailwind CSS.
* Shadcn UI.
* TanStack Query.
* React Hook Form.
* Zod.
* TanStack Table.
* Zustand only where necessary for UI state.

## Backend

Use:

* Next.js Route Handlers for the MVP.

Structure the backend into:

* Controllers or route handlers.
* Service layer.
* Repository layer.
* Validation layer.
* Permission layer.
* Audit layer.
* File-storage layer.

Do not place database or file-storage logic directly inside frontend components.

The architecture must allow the backend to be separated into NestJS later if required.

## Database

Use:

* MongoDB.
* Mongoose.
* MongoDB transactions where supported and necessary.
* Proper indexes.
* MongoDB text search for the MVP.
* MongoDB Atlas Search as an optional future upgrade.

MongoDB should store:

* Users.
* Departments.
* Roles.
* Permissions.
* Projects.
* Experiments.
* Folder metadata.
* File metadata.
* File-version metadata.
* Local file paths.
* Comments.
* Shares.
* Approvals.
* Notifications.
* Upload jobs.
* Migration jobs.
* Audit logs.
* Activity logs.

Do not store large files as Base64 strings inside MongoDB.

Do not store file binaries directly inside normal MongoDB documents.

GridFS should not be used in the initial version because the selected architecture uses local server storage.

## File Storage

Use private local server storage.

This means:

* Files are stored on the server’s persistent disk.
* File metadata is stored in MongoDB.
* Files are never stored in browser `localStorage`.
* Files are never placed directly inside a publicly accessible folder.
* Files must only be accessed through authenticated backend APIs.

Use a configurable storage directory:

```env
LOCAL_STORAGE_ROOT=/var/lib/biotech-drive/storage
TEMP_UPLOAD_ROOT=/var/lib/biotech-drive/temp
QUARANTINE_ROOT=/var/lib/biotech-drive/quarantine
PREVIEW_ROOT=/var/lib/biotech-drive/previews
EXPORT_ROOT=/var/lib/biotech-drive/exports
MAX_UPLOAD_SIZE_MB=2048
```

Use separate directories for:

```text
storage/
├── originals/
├── versions/
├── previews/
├── quarantine/
├── migration-staging/
├── temporary/
├── exports/
└── archives/
```

Suggested internal structure:

```text
originals/{organizationId}/{departmentId}/{fileId}/{versionId}
versions/{fileId}/{versionId}
previews/{fileId}/{versionId}
quarantine/{uploadSessionId}
migration-staging/{migrationJobId}
exports/{userId}/{exportJobId}
```

Never use only the original filename as the physical storage name.

Generate secure UUID-based filenames.

Keep the original filename in MongoDB for display and download.

---

# 3. Important Local Storage Rules

Local storage must mean **private server-side filesystem storage**, not browser localStorage.

Implement the following rules:

1. Store files outside the public web directory.
2. Never expose direct physical file paths to users.
3. Never allow requests such as `/uploads/secret-file.pdf`.
4. All preview and download requests must pass through the backend.
5. Validate the authenticated user before reading any file.
6. Validate file-level and folder-level permissions.
7. Prevent directory traversal attacks.
8. Normalize and validate every generated path.
9. Never trust a filename supplied by the user.
10. Use generated storage names.
11. Calculate SHA-256 checksums.
12. Record file size and MIME type.
13. Prevent executable uploads where unnecessary.
14. Never execute uploaded scripts.
15. Never overwrite an existing file version.
16. Use persistent Docker volumes in production.
17. Include backup and restore procedures.
18. Track storage usage by user, department, and project.
19. Create configurable upload-size limits.
20. Use an abstraction layer so local storage can later be replaced with S3, MinIO, Cloudflare R2, or another object-storage system.

Create a storage interface such as:

```ts
interface StorageProvider {
  saveFile(input: SaveFileInput): Promise<StoredFile>;
  getFile(fileKey: string): Promise<NodeJS.ReadableStream>;
  deleteFile(fileKey: string): Promise<void>;
  fileExists(fileKey: string): Promise<boolean>;
  moveFile(sourceKey: string, destinationKey: string): Promise<void>;
  getFileMetadata(fileKey: string): Promise<StoredFileMetadata>;
}
```

Implement `LocalStorageProvider` first.

Do not hardcode local-storage logic throughout the application.

---

# 4. Deployment Architecture

This application must not be deployed on an environment with temporary or ephemeral storage.

Do not deploy file storage on:

* Vercel serverless filesystem.
* Netlify serverless filesystem.
* Temporary containers without persistent volumes.
* Platforms where files disappear after redeployment.

Recommended deployment:

* Ubuntu VPS.
* Docker.
* Docker Compose.
* Nginx reverse proxy.
* Next.js application container.
* MongoDB container or MongoDB Atlas.
* Persistent mounted storage volume.
* HTTPS certificate.
* Automated backups.

Recommended production structure:

```text
Internet
   ↓
Nginx
   ↓
Next.js Application
   ├── MongoDB
   ├── Persistent File Volume
   ├── Background Worker
   └── Backup Service
```

Use separate environments:

* Development.
* Staging.
* Production.

Use separate MongoDB databases and file-storage directories for every environment.

---

# 5. Company Email–Only Authentication

The platform is only for company employees.

Requirements:

* No public registration.
* No personal email accounts.
* Only approved company email domains.
* Company email domain must be configured through environment variables.
* Admin must be able to activate or deactivate employees.
* Deactivated users must immediately lose access.
* Users should not automatically receive access only because they own an email on the company domain unless company policy allows it.

Use:

```env
COMPANY_EMAIL_DOMAINS=company.com,subsidiary.com
ALLOW_AUTO_PROVISIONING=false
```

Preferred authentication options:

1. Google Workspace OAuth.
2. Microsoft Entra ID OAuth.
3. Email and password with company-domain validation.
4. Company-email OTP as an optional fallback.

For email and password authentication, implement:

* Argon2id or bcrypt password hashing.
* Secure HTTP-only cookies.
* Session rotation.
* Password reset.
* Login-rate limiting.
* Failed-login lockout.
* Session expiration.
* Device and login history.
* Optional MFA.
* CSRF protection.

Company email validation determines who may sign in.

Role and permission records in MongoDB determine what they may access.

---

# 6. User Roles

Create configurable Role-Based Access Control.

Default roles:

* Super Admin.
* Company Admin.
* R&D Head.
* Department Head.
* Project Lead.
* Research Scientist.
* Lab Technician.
* Data Analyst.
* Reviewer.
* Management Viewer.

Do not include external collaborators in the initial MVP unless explicitly enabled later.

Permissions:

* View.
* Preview.
* Upload.
* Download.
* Create folders.
* Rename.
* Move.
* Copy.
* Comment.
* Share internally.
* Edit metadata.
* Upload new version.
* Submit for review.
* Review.
* Approve.
* Archive.
* Restore.
* Delete.
* Export.
* Manage access.
* Manage users.
* View audit logs.

Permission scope:

* Company.
* Department.
* Project.
* Folder.
* File.

Every backend API must independently validate permission.

Do not trust role or permission information sent by the frontend.

---

# 7. Google Drive–Like Modules

Build the following navigation:

* Home.
* My Drive.
* Department Drives.
* Project Drives.
* Shared with Me.
* Recent.
* Starred.
* Pending Reviews.
* Approved Files.
* Archive.
* Trash.
* Admin.

Users should be able to:

* Create folders.
* Create nested folders.
* Upload one or multiple files.
* Upload folders.
* Drag and drop uploads.
* Rename files and folders.
* Move files and folders.
* Copy files.
* Star files.
* View recent files.
* Preview supported files.
* Download files.
* Upload new versions.
* Restore older versions.
* Search files.
* Filter files.
* Share internally.
* Comment.
* Request review.
* Approve or reject.
* Archive.
* Move to Trash.
* Restore from Trash.

Provide:

* List view.
* Grid view.
* Breadcrumbs.
* Right-click context menu.
* File details panel.
* Upload progress.
* Activity timeline.
* Storage usage.
* Responsive interface.
* Light and dark modes.
* Loading states.
* Empty states.
* Error states.
* Permission-denied states.

---

# 8. Upload Flow

Use a secure server upload flow.

For normal uploads:

1. User selects a file.
2. Frontend requests upload authorization.
3. Backend validates the session.
4. Backend validates folder permission.
5. Backend validates filename, extension, MIME type, and expected size.
6. Backend creates an upload session in MongoDB.
7. Backend receives the file through a streaming upload.
8. File is written to the quarantine directory.
9. Backend calculates a checksum.
10. Backend validates the completed file size.
11. Background processing begins.
12. File is moved to the private storage directory.
13. File metadata is saved in MongoDB.
14. File status becomes ready.
15. An audit log is created.

For large files:

* Use streaming uploads.
* Do not load the complete file into server memory.
* Support chunked upload.
* Support resumable upload.
* Store temporary chunks securely.
* Delete expired incomplete uploads.
* Make finalization idempotent.

Upload statuses:

* Pending.
* Uploading.
* Processing.
* Quarantined.
* Ready.
* Failed.
* Rejected.
* Archived.

---

# 9. File and Folder Data Model

## Folder

Each folder should contain:

* `_id`.
* `name`.
* `parentFolderId`.
* `driveType`.
* `ownerId`.
* `departmentId`.
* `projectId`.
* `pathAncestors`.
* `createdBy`.
* `createdAt`.
* `updatedAt`.
* `deletedAt`.
* `isStarred`.
* `status`.
* `permissions`.
* `inheritedPermissions`.

Do not use only a complete text path to represent folder hierarchy.

Store:

* Parent reference.
* Ancestor references.
* Generated folder ID.

## File

Each logical file should contain:

* `_id`.
* `displayName`.
* `originalFilename`.
* `folderId`.
* `ownerId`.
* `departmentId`.
* `projectId`.
* `experimentId`.
* `currentVersionId`.
* `approvedVersionId`.
* `category`.
* `tags`.
* `confidentiality`.
* `reviewStatus`.
* `approvalStatus`.
* `createdBy`.
* `createdAt`.
* `updatedAt`.
* `deletedAt`.
* `isStarred`.
* `status`.

## File Version

Each version should contain:

* `_id`.
* `fileId`.
* `versionNumber`.
* `storageKey`.
* `relativeStoragePath`.
* `originalFilename`.
* `storedFilename`.
* `fileSize`.
* `mimeType`.
* `extension`.
* `checksum`.
* `uploadedBy`.
* `uploadedAt`.
* `versionNote`.
* `processingStatus`.
* `reviewStatus`.
* `approvalStatus`.
* `isCurrent`.
* `isApproved`.

Never store an absolute server path in API responses.

---

# 10. Research Metadata

Allow files to be connected to:

* Department.
* Research project.
* Study.
* Experiment.
* Sample ID.
* Researcher.
* Protocol.
* Instrument.
* Organism or biological material.
* Batch or lot number.
* Research date.
* Result.
* File category.
* Document type.
* Data type.
* Status.
* Tags.
* Confidentiality.
* Review status.
* Approval status.

Do not make every field mandatory.

Use metadata templates based on:

* Department.
* File type.
* Research category.
* Project type.
* Experiment type.

Recommended project folders:

```text
01_Project Overview
02_Research Proposal
03_Protocols and SOPs
04_Experiments
05_Samples
06_Raw Data
07_Processed Data
08_Analysis
09_Results
10_Reports
11_Approvals
12_Archived Files
```

Allow administrators to edit folder templates.

---

# 11. File Versioning

Implement file versioning similar to Google Drive.

Users should be able to:

* Upload a new version.
* View previous versions.
* Download previous versions.
* Restore an older version as a new current version.
* Add version notes.
* See who uploaded each version.
* See the upload time.
* See version status.
* See approval history.

Version labels:

* Draft.
* Under Review.
* Changes Requested.
* Approved.
* Final.
* Superseded.
* Archived.

Rules:

* Never overwrite an old version.
* Every version must have a different physical storage key.
* Approved versions must become read-only.
* Any modification after approval creates a new version.
* Only one version may be the current approved version.
* Restoring an older version must create a new version rather than silently changing history.

---

# 12. Search

Build search across:

* File names.
* Folder names.
* Project names.
* Experiment IDs.
* Sample IDs.
* Tags.
* File metadata.
* Researcher.
* Department.
* File category.
* Status.
* Review status.
* Approval status.
* Dates.

For the MVP, use:

* MongoDB indexes.
* MongoDB text indexes.
* Regex only for limited prefix searches.
* Server-side filtering.
* Pagination.

Do not run uncontrolled regex searches across large collections.

Search results must always be filtered by user permissions.

Unauthorized users must not see:

* Restricted filenames.
* Restricted snippets.
* Restricted metadata.
* Folder locations.
* The existence of restricted records.

Optional later upgrade:

* MongoDB Atlas Search.
* Extracted PDF and DOCX content.
* OCR.
* Semantic search.
* AI research assistant.

---

# 13. Preview and Download

Supported previews:

* PDF.
* Images.
* Text.
* CSV.
* JSON.
* XML.
* Source code.
* Audio.
* Video where supported.

For DOCX, XLSX, and PPTX:

* Use safe preview libraries.
* Do not execute macros.
* Do not execute embedded scripts.
* Generate preview files where practical.

Secure preview flow:

1. User requests preview.
2. Backend validates the session.
3. Backend validates permission.
4. Backend resolves the physical file.
5. Backend streams the file or preview.
6. Backend creates an activity and audit record.

Secure download flow:

1. User requests download.
2. Backend validates permission.
3. Backend resolves the current or requested version.
4. Backend safely sets download headers.
5. Backend streams the file.
6. Backend records download history.

Never reveal the physical filesystem path.

---

# 14. Internal Sharing

Support internal sharing with:

* Individual employees.
* Departments.
* Project teams.
* Internal roles.

Access levels:

* Viewer.
* Commenter.
* Editor.
* Reviewer.
* Approver.
* Manager.

Do not support public links in the MVP.

Do not support “Anyone with the link.”

Support:

* Share.
* Revoke access.
* Change access level.
* Folder permission inheritance.
* File-specific permissions.
* View history.
* Download history.
* Internal comments.
* Mentions.
* Review requests.

Permission changes should take effect immediately.

---

# 15. Review and Approval

Use the workflow:

**Draft → Submitted for Review → Changes Requested → Approved → Final → Archived**

Reviewers can:

* Add comments.
* Request changes.
* Approve.
* Reject.
* Add approval notes.
* View version history.
* Confirm the exact version being approved.

Approved files must become read-only.

Any later update must create a new version.

Store:

* Reviewer.
* Decision.
* Comment.
* Version ID.
* Date and time.
* User IP where appropriate.
* User agent.
* Approval history.

---

# 16. Audit Logs

Create append-only audit logs for:

* Login.
* Failed login.
* Upload.
* Download.
* Preview.
* Folder creation.
* Rename.
* Move.
* Copy.
* Share.
* Permission change.
* New version.
* Comment.
* Review request.
* Approval.
* Rejection.
* Archive.
* Restore.
* Delete.
* User activation.
* User deactivation.
* Role change.
* Google Drive import.
* Export.
* Backup action.

Audit records should contain:

* User ID.
* Company email.
* Action.
* Entity type.
* Entity ID.
* Previous value.
* New value.
* Timestamp.
* IP address.
* User agent.
* Request ID.
* Reason for sensitive actions.

Normal users must not edit or delete audit logs.

Restrict audit-log access to authorized administrators.

---

# 17. Backup and Recovery

Local server storage creates a single-server risk, so backup is mandatory.

Implement:

* Daily MongoDB backup.
* Daily incremental file backup.
* Weekly full backup.
* Configurable backup retention.
* Off-server backup destination.
* Backup encryption.
* Backup verification.
* Restore testing.
* Storage-integrity verification.
* Checksum validation.
* Deleted-file retention.
* Trash retention period.
* Archive retention rules.

Do not keep the only backup on the same physical disk as the application.

Recommended backup targets:

* Another company server.
* NAS.
* Encrypted remote VPS.
* S3-compatible backup storage.
* Cloudflare R2 backup bucket.
* Encrypted external storage.

Even when primary storage is local, maintain at least one off-server backup.

---

# 18. Google Drive Migration

Create a controlled migration system.

Administrators should be able to:

* Connect Google Drive.
* Select folders.
* Scan files.
* Preserve folder hierarchy.
* Preserve filenames.
* Preserve dates where possible.
* Preserve original Drive IDs.
* Detect duplicates.
* Calculate checksums.
* Import files to local storage.
* Save metadata in MongoDB.
* Map folders to departments.
* Map folders to projects.
* Review imported files.
* Retry failed items.
* Pause and resume migration.
* Generate migration reports.

Migration states:

* Draft.
* Connected.
* Scanning.
* Importing.
* Paused.
* Needs Review.
* Partially Completed.
* Completed.
* Failed.

Never delete or modify the original Google Drive files automatically.

---

# 19. Admin Panel

Build administration modules for:

* Employees.
* Departments.
* Roles.
* Permissions.
* Project Drives.
* Department Drives.
* Folder templates.
* Metadata templates.
* Upload limits.
* Allowed file types.
* Storage quotas.
* Storage usage.
* Login history.
* Audit logs.
* Backup status.
* Migration jobs.
* Failed uploads.
* Quarantined files.
* System notifications.
* Application settings.

Admin should be able to:

* Activate users.
* Deactivate users.
* Change roles.
* Assign departments.
* Assign projects.
* Set upload limits.
* Set storage quotas.
* Retry failed processing.
* Review quarantined files.
* Restore deleted items.
* View system health.

---

# 20. Phase-Wise Development Plan

## Phase 0: Requirement Analysis and Architecture

Do not write production code yet.

Produce:

* Requirement understanding.
* Assumptions.
* MVP scope.
* Future scope.
* Application architecture.
* MongoDB ER-style diagram.
* MongoDB collection design.
* Indexing plan.
* Local-storage design.
* Folder hierarchy design.
* Authentication flow.
* Permission matrix.
* Upload flow.
* Preview flow.
* Download flow.
* File-versioning flow.
* Backup strategy.
* Deployment architecture.
* Security threat model.
* Google Drive migration strategy.
* UI wireframe descriptions.
* Testing strategy.

Acceptance criteria:

* Database and storage responsibilities are clearly separated.
* File binaries are not stored in MongoDB.
* Local files are outside the public directory.
* Authentication and permission flow is documented.
* Backup requirements are defined.
* MVP and future features are separated.

After completing Phase 0, begin only Phase 1.

---

## Phase 1: Project Foundation

Build:

* Next.js project.
* TypeScript configuration.
* Tailwind CSS.
* Shadcn UI.
* MongoDB connection.
* Mongoose base models.
* Environment validation.
* Centralized error handling.
* Logging.
* Docker configuration.
* Docker Compose.
* Persistent storage volumes.
* Nginx development configuration.
* Health-check API.
* Basic layout.
* Sidebar.
* Header.
* Error pages.
* Loading states.

Acceptance criteria:

* Application starts through Docker Compose.
* MongoDB connects successfully.
* Persistent file volume is mounted.
* Environment variables are validated.
* No file data is lost when the application container restarts.
* Health-check endpoint reports database and storage status.

---

## Phase 2: Authentication and Employee Management

Build:

* Company-email-only login.
* Company-domain validation.
* Password or company OAuth authentication.
* Session management.
* Secure cookies.
* Logout.
* Password reset where applicable.
* Login-rate limiting.
* User model.
* Department model.
* Role model.
* Permission model.
* User activation and deactivation.
* Admin employee-management page.
* Login history.
* Protected routes.
* Protected APIs.

Acceptance criteria:

* Personal emails cannot register or log in.
* Deactivated employees cannot access the application.
* Every protected API validates authentication.
* Roles and permissions load from MongoDB.
* User sessions expire securely.

---

## Phase 3: Core Drive and Folder Management

Build:

* Home.
* My Drive.
* Department Drives.
* Project Drives.
* Folder creation.
* Nested folders.
* Breadcrumbs.
* List view.
* Grid view.
* Rename.
* Move.
* Copy.
* Recent items.
* Starred items.
* Trash.
* Restore.
* Soft deletion.
* Pagination.
* Sorting.

Acceptance criteria:

* Folder operations persist correctly.
* Circular folder movement is prevented.
* Users cannot access unauthorized folders.
* Deleted folders can be restored.
* Folder permissions inherit correctly.
* Large folder lists use pagination.

---

## Phase 4: Secure File Upload and Storage

Build:

* File upload.
* Multiple upload.
* Drag-and-drop upload.
* Streaming upload.
* Chunked upload.
* Upload sessions.
* Quarantine directory.
* MIME-type validation.
* Extension validation.
* Size validation.
* Generated physical filenames.
* SHA-256 checksums.
* MongoDB file metadata.
* Upload progress.
* Upload retry.
* Failed-upload cleanup.
* Storage quota enforcement.
* Audit logs.

Acceptance criteria:

* Files are stored outside the public directory.
* Files persist after application restart.
* Unauthorized users cannot upload.
* Unsupported files are rejected.
* Large files do not load entirely into memory.
* Duplicate finalization does not create duplicate file records.
* Physical paths are never returned to the browser.

---

## Phase 5: Preview and Download

Build:

* PDF preview.
* Image preview.
* Text preview.
* CSV preview.
* JSON and XML preview.
* Audio and video preview where supported.
* DOCX, XLSX, and PPTX preview strategy.
* Secure download API.
* Secure streaming.
* Download history.
* Preview history.
* Permission checks.
* Content-disposition handling.
* Range requests for large media files.

Acceptance criteria:

* Files cannot be accessed using guessed URLs.
* Every preview and download checks permission.
* Download headers use safe filenames.
* Large files stream correctly.
* Physical storage paths remain private.

---

## Phase 6: File Metadata, Versioning, and Search

Build:

* Research metadata.
* Metadata templates.
* File categories.
* Tags.
* File versioning.
* Version history.
* Version notes.
* Restore version.
* Approved version.
* MongoDB text search.
* Filters.
* Saved searches.
* Search-result permission filtering.
* Project, experiment, sample, and researcher filters.

Acceptance criteria:

* Previous file versions are never overwritten.
* Approved versions are read-only.
* Restoring a version creates a new version.
* Search does not expose unauthorized file information.
* Users can find files without knowing their folder location.

---

## Phase 7: Sharing and Collaboration

Build:

* Internal file sharing.
* Internal folder sharing.
* Access levels.
* Folder permission inheritance.
* Comments.
* Threaded replies.
* Mentions.
* Notifications.
* Activity history.
* Access revocation.
* View and download history.

Acceptance criteria:

* Revoked access stops working immediately.
* File-specific permissions work correctly.
* Folder inheritance works correctly.
* Comments do not modify file data.
* Unauthorized users do not receive restricted notifications.

---

## Phase 8: Review and Approval

Build:

* Submit for review.
* Reviewer assignment.
* Review comments.
* Changes requested.
* Resubmission.
* Approval.
* Rejection.
* Final status.
* Approval history.
* Approved-file locking.
* Review notifications.
* Pending-review dashboard.

Acceptance criteria:

* Reviewers approve a specific file version.
* Approved versions cannot be silently replaced.
* Every decision is auditable.
* Permission rules prevent unauthorized approval.
* Changes after approval create a new version.

---

## Phase 9: Research Organization

Build:

* Departments.
* Projects.
* Experiments.
* Research metadata.
* Project folder templates.
* Sample ID references.
* Protocol references.
* Instrument references.
* Raw Data classification.
* Processed Data classification.
* Analysis classification.
* Result classification.
* Final Report classification.
* Project dashboard.
* Related-file relationships.

Acceptance criteria:

* Files can be traced to projects and experiments.
* Users can filter by project, experiment, sample, and department.
* Folder templates generate correctly.
* The platform still feels like a Drive application rather than a complex LIMS.

---

## Phase 10: Google Drive Migration

Build:

* Google Drive API connection.
* Folder scanning.
* Migration staging.
* Batch import.
* Local-file writing.
* MongoDB metadata creation.
* Duplicate detection.
* Checksum comparison.
* Metadata mapping.
* Pause and resume.
* Retry failed items.
* Import review.
* Migration reports.

Acceptance criteria:

* Original Google Drive content remains unchanged.
* Imported files preserve the folder hierarchy.
* Duplicate imports are prevented.
* Failed items can be retried.
* Every migration item has an audit history.

---

## Phase 11: Backup, Security, and Production Hardening

Complete:

* MongoDB backups.
* File backups.
* Off-server backups.
* Restore procedures.
* Backup verification.
* Malware-scanning integration.
* Rate limiting.
* CSRF protection.
* Security headers.
* Path-traversal testing.
* IDOR testing.
* Permission testing.
* Upload-abuse testing.
* Storage-limit testing.
* Performance optimization.
* MongoDB index review.
* Monitoring.
* Application logs.
* Disk-usage alerts.
* Backup alerts.
* CI/CD.
* Production Docker setup.
* HTTPS.
* Nginx.
* Employee documentation.
* Admin documentation.

Acceptance criteria:

* Security tests pass.
* Backup restoration has been tested.
* Files survive deployment and container restart.
* Disk usage is monitored.
* Production and staging data remain separated.
* No secret exists in the repository.
* Critical actions have audit logs.

---

## Phase 12: Optional Advanced Features

Only begin after the core system is stable.

Possible features:

* MongoDB Atlas Search.
* OCR.
* Document content extraction.
* AI search assistant.
* Research summaries.
* Related-document recommendations.
* Semantic search.
* External collaborator access.
* Mobile application.
* Desktop sync application.
* Antivirus automation.
* MinIO or S3 migration.
* Multiple-server storage.
* NAS integration.
* Disaster-recovery server.

---

# 21. Testing Requirements

Include:

* Unit tests.
* API tests.
* MongoDB integration tests.
* Authentication tests.
* Permission tests.
* IDOR tests.
* File-upload tests.
* Chunked-upload tests.
* Path-traversal tests.
* File-download tests.
* Preview tests.
* Versioning tests.
* Search-permission tests.
* Sharing tests.
* Approval tests.
* Audit-log tests.
* Migration tests.
* Backup and restore tests.
* End-to-end tests.
* Accessibility tests.

Create explicit tests proving that:

* One department cannot access another department’s restricted files.
* A user cannot guess a file ID and download it.
* A user cannot manipulate a file path.
* A deactivated user immediately loses access.
* Search does not expose restricted filenames.
* Approved files cannot be silently overwritten.
* Old versions remain available.
* Container restarts do not delete files.
* A failed upload does not create a valid file record.
* Backup files can be restored.

---

# 22. Required Environment Variables

Prepare a complete `.env.example`:

```env
NODE_ENV=development
APP_URL=http://localhost:3000

MONGODB_URI=mongodb://mongodb:27017/biotech_drive
MONGODB_DATABASE=biotech_drive

AUTH_SECRET=
SESSION_SECRET=

COMPANY_EMAIL_DOMAINS=company.com
ALLOW_AUTO_PROVISIONING=false

LOCAL_STORAGE_ROOT=/data/storage
TEMP_UPLOAD_ROOT=/data/temp
QUARANTINE_ROOT=/data/quarantine
PREVIEW_ROOT=/data/previews
EXPORT_ROOT=/data/exports

MAX_UPLOAD_SIZE_MB=2048
DEFAULT_USER_STORAGE_QUOTA_GB=20
DEFAULT_DEPARTMENT_STORAGE_QUOTA_GB=500

TRASH_RETENTION_DAYS=30
INCOMPLETE_UPLOAD_RETENTION_HOURS=24

BACKUP_ROOT=/data/backups
BACKUP_RETENTION_DAYS=30

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=

SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=
```

Never commit actual secrets.

---

# 23. Expected Output Before Coding

Before implementation, provide:

1. Business requirement summary.
2. Assumptions.
3. MVP scope.
4. Future scope.
5. Complete system architecture.
6. MongoDB collection diagram.
7. Collection schemas.
8. Indexing strategy.
9. Local-storage directory architecture.
10. Storage-provider abstraction.
11. Authentication flow.
12. Permission matrix.
13. Upload sequence.
14. Preview sequence.
15. Download sequence.
16. Versioning sequence.
17. Backup architecture.
18. Deployment architecture.
19. API endpoint list.
20. Security threat model.
21. Google Drive migration strategy.
22. Page and component structure.
23. Phase-wise task checklist.
24. Acceptance criteria for every phase.
25. Docker and Docker Compose strategy.

After presenting Phase 0 architecture, begin only Phase 1.

At the end of every phase:

* List completed work.
* List files created or modified.
* Run relevant tests.
* Report failed tests.
* Report unresolved issues.
* Confirm acceptance criteria.
* Update documentation.
* Do not skip incomplete critical functionality.
* Do not start the next phase if critical failures remain.
* Do not break completed functionality while implementing later phases.

---

# 24. Final Success Criteria

The platform is successful when:

1. Only authorized employees using approved company email accounts can access it.
2. Employees can use it as easily as Google Drive.
3. MongoDB stores structured metadata and permissions.
4. Actual files remain in private persistent server storage.
5. No file is publicly accessible through its physical path.
6. Employees can find files without knowing their folder.
7. Users can identify the latest approved version.
8. Previous file versions are preserved.
9. Every sensitive action is auditable.
10. Unauthorized users cannot discover or download restricted files.
11. Research files can be connected to projects and experiments.
12. Existing Google Drive files can be migrated safely.
13. Files survive application redeployment and container restart.
14. MongoDB and file storage are backed up.
15. The complete application is built and tested phase by phase.

Begin with Phase 0.

Do not immediately create random pages or disconnected code.
