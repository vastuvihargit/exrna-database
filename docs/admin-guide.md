# Administrator guide

For the people who run the Research Drive day to day. Server operations live in the
[runbook](./operations/runbook.md); this is about people, access and content.

---

## The access model, in one paragraph

**Sign-in** is decided by email domain. **Access** is decided by roles granted at a
scope. The two are separate on purpose: owning a company address gets somebody to the
login page, and nothing more. You create the account, and you grant the roles.

Scopes nest — company, department, project, folder, file. A grant at department level
applies to everything in that department's drive unless something below it says
otherwise. Granting or revoking a role signs the employee out, so the change applies at
once rather than at their next login.

---

## Employees

**Admin → Employees.**

- **Create** an account before the employee first signs in. Set their department; it
  determines which department drive they land in and which quotas apply.
- **Deactivate** to remove access immediately, including sessions already open. Prefer
  this to deletion: it preserves the audit trail, and their uploads stay where they are —
  files belong to departments and projects, not to individuals.
- **Reactivate** restores access unchanged.
- **Change roles** to adjust what somebody can do. Every change is audited with the
  before and after values.

**Login history** shows successes and failures with IP and device. A run of failures
against one account is worth a phone call.

### The default roles

| Role | Roughly |
| --- | --- |
| Super Admin | Everything, including other administrators |
| Company Admin | People, departments, settings, audit |
| R&D Head | All research content, company-wide |
| Department Head | Their department, including granting access within it |
| Project Lead | Their project's drive and team |
| Research Scientist | Upload, organise, submit for review |
| Lab Technician | Upload and organise within assignments |
| Data Analyst | Read data, produce analysis |
| Reviewer | Review and approve |
| Management Viewer | Read approved output |

A department head holds `access.manage` **for their own department**. That deliberately
does not extend to company-wide settings such as folder templates — those shape every
other department's drives.

---

## Departments and projects

**Departments** own drives and quotas. Set a department quota that reflects what that team
actually generates; the default is 500 GB.

**Projects** get a drive built from the twelve-folder research template. Do not rename the
template folders in individual projects — the numbering is what makes one project
navigable to somebody who has only worked on another.

**Experiments** are the link between a file and what produced it. A file linked to an
experiment inherits its project, so it can be traced even when it was uploaded somewhere
generic. Encourage this; it costs one dropdown at upload time and answers "what produced
this file?" for ever.

---

## Templates

**Admin → Templates.** Folder templates and metadata templates, per organization.

Two things to know:

1. **Editing a template never rewrites existing drives.** Renaming `06_Raw Data` must not
   rename it in forty live projects. The project dashboard reports which template folders
   a drive is missing instead.
2. **Metadata templates can only arrange fields the system declares.** You cannot invent a
   new field key from the UI. This is a security boundary, not a limitation — field keys
   become database paths, and inventing one would reach past the allow-list that exists to
   stop exactly that.

Template editing requires company-scoped `access.manage`.

---

## Reviews and approvals

The workflow is enforced, not advisory:

- A reviewer approves **a specific version**, and that version id is recorded.
- Approved versions become read-only. Any later change creates a new version and starts
  the workflow again.
- Only one version can be the current approved one.
- Every decision — reviewer, verdict, comment, version, timestamp, IP, user agent — is
  stored permanently.

If somebody asks you to "just update the approved file", the answer is that the system
will make it a new version and it will need approving again. That is the feature.

---

## Migrating from Google Drive

**Admin → Migrations.** Connect, scan, import, review.

- **The originals are never touched.** Not by policy — structurally. The system requests
  read-only scope and every Drive call goes through one function that hard-codes a GET.
- Hierarchy, filenames and dates are preserved; the original Drive ids are kept as
  provenance.
- Duplicates are detected by **checksums this server computed while streaming**, not by
  Google's reported hash.
- Imported files are checked exactly as uploads are. A disguised executable is flagged for
  review, not imported.
- Imported files take the destination folder's confidentiality or stricter. An import can
  never widen access.
- Pause, resume and retry are all safe; re-scanning imports nothing twice.

A job only reports `completed` when there is nothing left **and** nothing wrong. Anything
skipped or failed leaves it in a state that says a human should look — that is the design,
not an error.

Migration requires **company-scoped** `access.manage`, and the destination is additionally
checked as an ordinary upload target. You cannot import into a folder you could not upload
a single file to by hand.

---

## Storing files in the company Shared Drive

**This is the opposite direction from the section above, and the two are easy to confuse.**
"Migrations" reads somebody's Drive *into* this platform. This is about where this platform
keeps its own files: on this server, or in a company-owned Google Shared Drive.

**Admin → Storage migration.** Plan, run, verify, retry, roll back.

Employees see none of it. There is no storage provider anywhere in their interface, no Drive
ids, no migration status — a file opens, downloads, is shared and is reviewed exactly as
before, wherever its bytes happen to live. That is the requirement, not a nicety.

### What you need to know to run it

- **A file is never offline.** Every version reads from wherever its own record says. Files
  not yet migrated read from this server; migrated ones read from Drive; a file with an older
  version in each is normal during a migration and is not an error.
- **A failed transfer is a file that did not move**, not a file that broke. It stays local and
  stays readable. Retry it when you have fixed the cause.
- **Local copies are kept** for `LOCAL_COPY_RETENTION_DAYS` (30 by default) after a version
  migrates. That retention *is* the undo button — rolling back moves no data precisely because
  the bytes never left — and it is also what lets a file still open if its Drive copy is
  deleted by somebody with the link.
- **Rollback is safe and reversible.** It flips records back to local storage and deletes
  nothing, including in Drive.

Follow `docs/storage-migration/10-phase-10-production-migration.md` for the order to migrate
in. The short version: never in one job, because a job is the unit of rollback.

### The three things on the System page

- **Files waiting for the Shared Drive.** Uploads that have not been copied across yet. Large
  ones are always queued by design, so a small number is normal. A number that keeps climbing
  means Drive has been unreachable — the files are safe and readable on this server, but disk
  is filling with copies that were meant to move on.
- **Shared Drive synchronization.** Whether the application is still hearing about things
  people change directly in Drive. "Never run" or a stale timestamp means it is not, and every
  symptom of that looks like everything being fine.
- **Approved documents that changed.** Somebody edited an approved document in Drive. It has
  gone back to needing review and its owner has been told; the earlier approval stays in the
  file's history. This needs a person: re-review it, or restore the document in Drive.

A **conflict** on a file almost always means it was moved to a different folder in Drive. That
move is *not* applied here, deliberately — in this application a file's folder decides who can
see it and whose quota it counts against, and a drag in the Drive web UI must not be able to
change that. Move it back in Drive, or move it here through the application.

### Reclaiming the disk afterwards

Once a batch has been migrated, verified and used for a while, the retained local copies can
be archived. This is an explicit action, never scheduled:

```
GET  /api/admin/storage/local-copies     — what is kept, and how much is now eligible
POST /api/admin/storage/local-copies     — { "action": "archive" }
```

`dryRun` defaults to true; pass `"dryRun": false` when you mean it.

**Archive first, and probably only.** Archiving moves the bytes aside — the disk comes back
and rollback still works. Deleting removes them, ends the ability to roll those versions back,
and ends the ability to serve them if their Drive copy ever goes missing. Deleting also
requires `DELETE_LOCAL_AFTER_MIGRATION=true`, and each file is re-checked against Drive at the
moment of deletion rather than trusted to a verification from weeks ago.

Take a backup before either.

---

## Audit log

**Admin → Audit log.** Filter by action, actor, entity, outcome, date.

Append-only. There is no edit and no delete, for anybody, including Super Admins. Records
hold the actor, the action, the entity, what changed from and to, the time, the IP, the
user agent and the request id.

Use it when somebody asks who approved something, when a file went missing, or when
access appeared that shouldn't have.

---

## System status

**Admin → System.** Disk, backups, restore drills, the upload queue, antivirus, database.

Three things there are worth checking weekly even when nothing is red:

1. **Off-server copy.** If it says the only backup is on this server, that is the single
   most important thing to fix.
2. **Restore drill.** "Never rehearsed" means the backups are an untested assumption.
3. **Quarantine.** Files sitting there need a decision from somebody; they do not resolve
   themselves.

The same checks run every 15 minutes and alert without waiting for you to open the page.

---

## Quotas and limits

| Setting | Default | Where |
| --- | --- | --- |
| Max upload size | 2048 MB | `MAX_UPLOAD_SIZE_MB` |
| Per-user quota | 20 GB | `DEFAULT_USER_STORAGE_QUOTA_GB`, per-user override in Employees |
| Per-department quota | 500 GB | `DEFAULT_DEPARTMENT_STORAGE_QUOTA_GB` |
| Free-disk floor | 10 GB | `MIN_FREE_DISK_GB` — uploads stop before the disk is full |
| Trash retention | 30 days | `TRASH_RETENTION_DAYS` |
| Local-copy retention after migration | 30 days | `LOCAL_COPY_RETENTION_DAYS` — how long the undo button lasts |
| Deleting local copies at all | off | `DELETE_LOCAL_AFTER_MIGRATION` |
| Opening Google docs in Google's editor | off | `GOOGLE_DRIVE_NATIVE_EDITOR_ENABLED` — only turn this on if your staff are members of the Shared Drive |

Raising a quota is immediate. Lowering one below current usage does not delete anything —
it stops further uploads until the user is back under.

---

## Routine

**Weekly** — System page; quarantine queue; failed uploads; new accounts still unused. With
the Shared Drive enabled, also: the transfer queue is draining, synchronization has run
recently, and nothing is sitting in **Approved documents that changed**.

**Monthly** — Audit log for permission grants; deactivate leavers; `npm run
review:indexes`; confirm the restore drill is passing.

**Quarterly** — Review department quotas against actual growth; a **manual** restore drill
alongside the automated one, timed, so your RTO is a measurement rather than a hope;
review who holds company-scoped `access.manage` and whether they all still need it.
