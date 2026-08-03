# Demo Guide — Biotech Research Drive

A plain-language explanation of what this product is, why it exists, and how to show it to
someone who is not technical.

**One-line version:** *It's our own private Google Drive, built for lab data — so you can always
tell which version of a file is the approved one, find anything without knowing what folder it's
in, and see exactly who did what.*

---

## Part 1 — The story (say this before you touch the screen)

### The problem today

Research files live in Google Drive. Drive is good at holding files and bad at everything else the
lab actually needs:

| What people say | What's really going on |
| --- | --- |
| *"I can't find that 2023 assay result."* | The only way to find a file is to remember the folder someone put it in. |
| *"Which one is the real final version?"* | `protocol_v3_FINAL_real.xlsx`. Every upload is a brand-new unrelated file. |
| *"Who approved this? Who downloaded it?"* | Drive's history is shallow and can't be pulled per-file. |
| *"That confidential protocol got shared too widely."* | Permissions are set file-by-file, by hand, by whoever remembered. |
| *"Which experiment does this spectrum belong to?"* | Nothing connects a file to a project, an experiment, or a sample. |

### What we built

The same everyday experience — folders, drag & drop, search, sharing — with five things Drive
can't do:

1. **A file has one identity and a history of versions.** Upload a new copy and it becomes
   *version 4 of the same document*, not a fifth file. Old versions stay forever.
2. **Approval is attached to a specific version.** "Approved" is never ambiguous about *what*
   was approved, and an approved version becomes read-only.
3. **Every file carries lab context** — project, experiment, sample ID, instrument, protocol,
   organism, batch, date, tags. Search replaces remembering.
4. **Permissions are structural, not manual.** Access follows role, department, and project.
   There are no public links — ever. Every access traces to a named employee.
5. **Everything is recorded.** Uploads, downloads, previews, shares, approvals, deletions.

### Where the files actually live

Files are stored on **our own private server**, not in a public cloud folder and never in a
web address anyone could stumble onto. Every single download passes through a permission check
first. Nothing is stored in your browser.

*(Optional, configurable: bytes can instead be kept on a company Google Shared Drive. Either way,
access still goes through our permission checks — the storage location is an internal detail.)*

### Analogy that lands with non-technical people

> Google Drive is a filing cabinet. This is a filing cabinet with a **librarian** — one who labels
> every document, keeps every draft, records who signed off on what, and never lets the wrong
> person open the wrong drawer.

---

## Part 2 — The demo walkthrough (~10 minutes)

Run these six beats in order. Each one answers a complaint from the table above.

### 0. Sign in *(30 sec)* — "Nobody gets in by accident"

Sign in with a company email. Point out: **no public sign-up**, personal addresses are rejected,
an administrator creates every account, and deactivating someone kills their access instantly.

### 1. The shell *(1 min)* — "It looks like what you already use"

Walk the left sidebar: **My Drive** (private to you), **Department drives**, **Project drives**,
**Shared with me**, **Recent**, **Starred**, **Pending reviews**, **Approved**, **Archive**,
**Trash**.

Open a project drive and show the **standard 12-folder template** (`01_Project Overview` →
`12_Archived Files`). Line to use: *"This is why someone can find your data in three years."*

### 2. Upload *(2 min)* — "Same as Drive, plus context"

Drag a couple of files in. Show the progress; mention large files upload in chunks and survive a
dropped connection.

Then open the metadata panel and fill in **project, experiment, sample ID, tags**. Say clearly:
*"None of this is mandatory — all of it is what makes step 3 possible."*

### 3. Search *(1.5 min)* — "Stop remembering folders"

Search a **sample ID** — everything that touched that sample appears, from every folder. Then a
**tag**, then an **experiment code**. Use the filter chips.

Key point: *"You only ever see what you're allowed to see. Restricted files don't appear, and
they're not even counted in the totals."*

### 4. Versions *(2 min)* — **the money shot**

Upload a file with the **same name** as an existing one. It becomes **version 2**, not a duplicate.

Open the version history: every version, who uploaded it, when, and their note. Download an old
one. Then restore an old version — and show that this creates a *new* version rather than erasing
history.

Line to use: *"This is the answer to 'which one is the current file?' — and it can't be gamed."*

### 5. Review & approval *(2 min)* — "Signed off means signed off"

Submit the file for review and pick a reviewer. Switch to the reviewer's account
(**Pending reviews**), leave a comment, then approve.

Show the result: the file is **Approved**, **read-only**, and the approval is stamped against
**that exact version**. Then edit it — the change starts a new draft, and the approved version
stays untouched.

Full lifecycle: **Draft → Submitted → Changes requested → Approved → Final → Archived**

### 6. Sharing & audit *(1.5 min)* — "Nothing is anonymous"

Share with a colleague, a department, or a project team. Six access levels: Viewer, Commenter,
Editor, Reviewer, Approver, Manager. Emphasize: **no "anyone with the link", ever.** Revoke access
and show it takes effect immediately, not at next sign-in.

Finish in **Admin → Audit log**: filter to the file you just used and show the trail — uploaded,
previewed, shared, approved, downloaded, by whom, when.

Closing line: *"When someone asks 'who approved this and when', the answer exists."*

---

## Part 3 — Questions you'll get, and the answers

| Question | Answer |
| --- | --- |
| *"Do we have to move everything by hand?"* | No. There's a built-in Google Drive importer: it scans, maps folders, imports, and skips duplicates. It is **read-only against Drive** — nothing in the existing Drive is changed or deleted. |
| *"What if we lose the server?"* | Daily database backups, daily incremental + weekly full file backups, encrypted and copied off-server, with an automated weekly restore drill. |
| *"Can someone sneak a virus in?"* | Uploads are quarantined, virus-scanned, and checked that the file's actual contents match its name before anything is stored. |
| *"Can I delete something by mistake?"* | Deleting offers Undo immediately; trash is recoverable for 30 days. Folder deletion asks first. |
| *"Is this a LIMS?"* | No — deliberately. It's a *drive*. Sample inventory, plate maps, and instrument integrations are explicitly out of scope. |
| *"Is it validated / 21 CFR Part 11 compliant?"* | **Do not claim this.** The design (immutable versions + full audit trail) is compatible with a future compliance project, but no compliance claim is being made today. |
| *"What about editing documents in the browser?"* | Not built. The unit of change here is a new version, not live co-editing. |
| *"Can we search inside file contents?"* | Not yet — today search covers names and metadata. Content search is the next planned phase. |
| *"How many people can use it?"* | Sized for 50–500 employees, 1–20 TB of data, files up to 2 GB each. |

---

## Part 4 — Setting up the demo environment

Do this **before** the meeting, not during it.

```bash
# Start everything (app + database + web server)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up

# Load demo departments, roles and accounts
npm run seed -- --demo
```

Then open **http://localhost:3000**.

### Demo accounts

All three share the password `Drive-Demo-2026!` (override with `--demo-password`). The email
domain is whatever `COMPANY_EMAIL_DOMAINS` is set to in `.env`.

| Person | Role | Department | Why they're in the demo |
| --- | --- | --- | --- |
| Maya Okonkwo | Department Head | Molecular Biology | Can **approve** — use her for the review step |
| Tomas Lindqvist | Senior Research Scientist | Bioinformatics | Contributor — use him to upload and submit |
| Priya Raman | Lab Technician | Analytical Chemistry | Can upload but **not delete** — use her to show permissions actually biting |

The three sit at deliberately different permission heights *and in different departments*, so
cross-department visibility is visible at all. Demo seeding **refuses to run against production.**

### Pre-demo checklist

- [ ] `npm run check:env` passes
- [ ] App loads and all three accounts sign in
- [ ] A few realistic files pre-uploaded with metadata filled in — don't type metadata live
- [ ] One file already at **version 3** with real version notes
- [ ] One file already **Approved**, so you can show the read-only state instantly
- [ ] A second browser (or private window) already signed in as the reviewer, so switching
      accounts isn't a 60-second detour

### If something breaks mid-demo

Skip forward. The beats are independent — versions (step 4) and approval (step 5) are the two that
sell the product, so protect those and drop steps 1, 2 or 6 if time or luck runs short.

---

## Part 5 — Where this stands

Phases 0–11 are complete: architecture, authentication, drive core, upload, preview, metadata and
versioning, sharing, review and approval, research organization, Google Drive migration, and
production hardening. **369 automated tests pass.** Phase 12 (content search, object storage,
external collaborators, desktop sync) is deliberately deferred until the core is proven in real use.

Deeper reading: [`README.md`](./README.md) · [`docs/employee-guide.md`](./docs/employee-guide.md) ·
[`docs/admin-guide.md`](./docs/admin-guide.md) · [`docs/phase-0/`](./docs/phase-0/README.md)
