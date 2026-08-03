# 11 — UI Structure, Pages & Wireframes

Design principle: **it must feel like Google Drive.** A scientist who has never read documentation
should be able to create a folder, drag files in, find them, and share them. Biotech metadata is
*progressive disclosure* — visible in a side panel, never a required gate before uploading.

## Route map

```
app/
├── (auth)/
│   ├── login                     # provider buttons + password form
│   ├── forgot-password · reset-password
│   └── access-denied             # "your account is not provisioned / deactivated"
├── (drive)/                      # layout: Sidebar + Header + UploadDock + CommandPalette
│   ├── home                      # dashboard
│   ├── my-drive/[[...folderId]]
│   ├── departments               · departments/[departmentId]/[[...folderId]]
│   ├── projects                  · projects/[projectId]            (dashboard)
│   │                             · projects/[projectId]/files/[[...folderId]]
│   │                             · projects/[projectId]/experiments/[experimentId]
│   ├── shared · recent · starred
│   ├── reviews                   # Pending Reviews (inbox + submitted-by-me)
│   ├── approved · archive · trash
│   ├── search                    # ?q= &facets
│   └── files/[fileId]            # full-page preview + details + versions + comments
└── (admin)/admin/
    ├── (overview) · users · users/[id] · departments · projects · roles
    ├── folder-templates · metadata-templates · settings
    ├── storage · audit-logs · login-history · backups
    ├── migrations · migrations/[id] · uploads (failed) · quarantine · jobs
```

## Layout wireframes

### Drive shell

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ☰  🧬 Biotech Drive     [ 🔍 Search files, projects, samples…    ⌘K ]   ?  🌓  👤│
├────────────────┬─────────────────────────────────────────────────────────────┤
│ [＋ New ▾]     │  My Drive › EXR-2026-014 › 06_Raw Data          [▤][▦] [⋮]  │
│                │ ┌─────────────────────────────────────────────────────────┐ │
│ 🏠 Home        │ │ Name ▲            Owner    Modified   Size   Status     │ │
│ 📁 My Drive    │ │ 📁 2026-03-runs   A. Rao   Mar 14      —      —          │ │
│ 🏢 Departments │ │ 📄 assay_v3.xlsx  M. Sen   Mar 12    2.1 MB  ✅ Approved │ │
│   └ Molecular  │ │ 📊 spectra.mzML   A. Rao   Mar 11    412 MB  🕓 In review│ │
│   └ Analytics  │ │ 📄 protocol.pdf   J. Lin   Mar 02    880 KB  ✅ Approved │ │
│ 🧪 Projects    │ │ 🖼 gel_08.tiff    M. Sen   Feb 28     44 MB   Draft      │ │
│   └ EXR-2026-14│ │                                                          │ │
│ 🤝 Shared      │ │  ← 1–50 of 312 →                                         │ │
│ 🕘 Recent      │ └─────────────────────────────────────────────────────────┘ │
│ ⭐ Starred     │                                                             │
│ ✅ Reviews (3) │  ┌ Details ─────────────────────┐   (right panel, toggle)   │
│ 📗 Approved    │  │ assay_v3.xlsx    v4 · Approved│                          │
│ 🗄 Archive     │  │ Project  EXR-2026-014         │                          │
│ 🗑 Trash       │  │ Experiment EXP-014-021        │                          │
│ ⚙ Admin        │  │ Samples  S-1042, S-1043       │                          │
│                │  │ Category Processed Data       │                          │
│ ▓▓▓▓▓░░ 12/20GB│  │ Tags  hplc, stability         │                          │
└────────────────┴──┴───────────────────────────────┴──────────────────────────┘
        ┌ Uploads ──────────────────┐  (bottom-right dock, persists across nav)
        │ spectra.mzML  ▓▓▓▓▓▓░ 78% │
        │ gel_09.tiff   ✓ Done      │
        └───────────────────────────┘
```

### File details panel (tabs)

```
┌ assay_v3.xlsx ───────────────────────────────── ✕ ┐
│ [Details] [Versions] [Comments] [Activity] [Access]│
│ ─────────────────────────────────────────────────  │
│ Details:  Current v4 · Approved v4  ✅              │
│           Owner M. Sen · 2.1 MB · Modified Mar 12   │
│           Confidentiality: Confidential 🔒          │
│           Project / Experiment / Samples / Protocol │
│           Instrument / Organism / Batch / Date      │
│           Tags [hplc][stability]        [Edit]      │
│ ─────────────────────────────────────────────────  │
│ Versions: v4 ✅ Approved  M.Sen  Mar 12  [⤓][↺]     │
│           v3    Superseded M.Sen Mar 08  [⤓][↺]     │
│           v2    Superseded A.Rao Feb 20  [⤓][↺]     │
│           v1    Superseded A.Rao Feb 11  [⤓][↺]     │
│           [⬆ Upload new version]                    │
└────────────────────────────────────────────────────┘
```

Where the current version ≠ the approved version, the header shows a persistent amber banner:
*"Latest version v5 is not approved. Approved version is v4."* with buttons to open either. This is
the direct answer to the "which is the latest approved version?" pain point.

### Other key screens

**Home** — greeting; four stat tiles (my files, pending my review, submitted by me, storage used);
*Recent files* grid; *Needs your review* list; *Recent activity* timeline; *My projects* cards.

**Search** — query box + facet rail (project, experiment, department, category, tags, sample id,
researcher, review/approval status, confidentiality, date range, file type, size); results as a
table with the matched-field reason and full breadcrumb, so users learn where things live.
Zero-result state suggests relaxing facets — never "no permission", which would leak existence.

**Preview page** — viewer (pdf.js / image / table / text / media) at 70 %, details panel at 30 %,
toolbar: download, new version, share, submit for review, star, move, rename, archive, delete.
Approved files show a lock chip; the download button offers "current" and "approved" when they differ.

**Review inbox** — two tabs (To review / Submitted by me); each row shows file, requester, exact
version under review, age, due date; the decision drawer shows the version preview, the version
number being decided on, a diff-of-metadata summary, and Approve / Request changes / Reject with a
mandatory note for the latter two.

**Project dashboard** — header (code, lead, status, dates), stat tiles (files, experiments, storage,
pending reviews), the 12 template folders as tiles, experiment table, recent activity.

**Admin** — left sub-nav; users table (TanStack Table: email, role chips, department, status,
last login, storage) with row actions; audit-log viewer with filter rail, expandable before/after
JSON, and CSV export; storage page with per-department/user/project bars and disk headroom;
migration wizard (Connect → Select → Scan → Map → Preview → Import → Report).

## Component inventory

**Layout** — `AppShell`, `Sidebar` (+ `StorageMeter`, `NavItem`), `Header` (+ `GlobalSearch`,
`CommandPalette`, `ThemeToggle`, `NotificationBell`, `UserMenu`), `Breadcrumbs`, `PageHeader`.

**Drive** — `DriveToolbar` (view toggle, sort, filter, new), `FileList` (TanStack Table, multi-select,
keyboard nav), `FileGrid`, `FileRow`, `FileCard`, `FileTypeIcon`, `StatusBadge`, `ContextMenu`,
`EmptyState`, `PermissionDeniedState`, `LoadingSkeleton`, `Pagination`, `DetailsPanel`, `MoveDialog`
(folder tree picker), `RenameDialog`, `NewFolderDialog`, `ConfirmDialog`, `StarButton`.

**Upload** — `UploadDropzone` (full-page drag overlay), `UploadDock`, `UploadItem` (progress, pause,
retry, cancel), `FolderUploadInput` (`webkitdirectory`), `UploadConflictDialog` (new version vs keep both).

**Metadata & research** — `MetadataForm` (RHF + Zod, template-driven), `TagInput`, `SampleIdInput`,
`ProjectPicker`, `ExperimentPicker`, `ConfidentialitySelect`, `CategorySelect`, `MetadataTemplateRenderer`.

**Preview** — `PreviewRouter`, `PdfViewer`, `ImageViewer`, `TextViewer`, `CsvTableViewer`,
`JsonXmlViewer`, `MediaPlayer`, `OfficePreview`, `UnsupportedPreview`.

**Versions & review** — `VersionList`, `VersionRow`, `UploadVersionDialog`, `RestoreVersionDialog`,
`ApprovalBanner`, `ReviewRequestDialog`, `ReviewDecisionDrawer`, `ApprovalHistory`, `ReviewInboxTable`.

**Sharing & collaboration** — `ShareDialog` (principal search: users/departments/projects/roles),
`AccessLevelSelect`, `AccessList`, `InheritanceNotice`, `CommentThread`, `CommentComposer`
(@mentions), `ActivityTimeline`, `AccessLogTable`.

**Admin** — `UserTable`, `UserDrawer`, `RoleEditor`, `PermissionMatrixEditor`, `DepartmentForm`,
`ProjectForm`, `FolderTemplateEditor`, `MetadataTemplateEditor`, `AuditLogTable`, `AuditDetailDrawer`,
`StorageUsageChart`, `BackupStatusCard`, `MigrationWizard`, `QuarantineTable`, `SystemHealthCard`.

## State management

| Concern | Tool |
|---|---|
| Server data (files, folders, search, reviews) | **TanStack Query** — the only place `fetch` is called, via `src/hooks/**`; optimistic updates for rename/star/move with rollback |
| Forms & validation | **React Hook Form + Zod** — the same Zod schemas the API validates with, imported from `src/server/validation` (types only) |
| Tables | **TanStack Table** — sorting, selection, column visibility, virtualized for large folders |
| UI-only state | **Zustand** — sidebar collapse, view mode, details-panel tab, selection set, upload dock queue. Nothing server-derived lives here. |
| Theme | `next-themes`, class strategy, system default |

## Accessibility & responsiveness

- Keyboard: `⌘K` palette, `/` search, `n` new folder, `u` upload, `Del` trash, `Enter` open,
  `Space` select, arrows to navigate, `Esc` closes panels. Every dialog traps focus and restores it.
- All shadcn primitives are Radix-based (labelled, ARIA-correct); icon-only buttons carry
  `aria-label`; live regions announce upload completion and errors.
- Contrast ≥ 4.5:1 in both themes; focus rings never removed; motion respects `prefers-reduced-motion`.
- Breakpoints: sidebar becomes a sheet < 1024 px; the table collapses to a card list < 768 px;
  the details panel becomes a bottom sheet on mobile. Upload and preview work on tablets.
- axe-core assertions run in the e2e suite on the ten primary screens.

## State coverage requirement

Every data-driven screen implements five states — **loading** (skeleton, not a spinner),
**empty** (with the primary action), **error** (with retry and the request id),
**permission-denied** (explains, offers "request access", never reveals the resource), and
**populated**. Missing any of the five fails code review.
