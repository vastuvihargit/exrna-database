# Using the Research Drive

This works like Google Drive. Folders, files, drag and drop, search, sharing. What is
different is aimed at one problem: on a shared Drive, nobody can tell which version of a
protocol is the approved one. Here you can.

---

## Signing in

Use your company email address. There is no public sign-up, and a personal address will
not work — even if you own a company address, an administrator creates the account first.

If sign-in is refused, it is one of three things: the account has not been created yet,
it has been deactivated, or the address is not on an approved domain. The message tells
you which, and Support can fix all three.

---

## Where things live

| | What it is |
| --- | --- |
| **My Drive** | Yours. Nobody else can see it — not your department head, not an administrator, unless you share something. |
| **Department drives** | Your department's shared space. |
| **Project drives** | One per research project, created from a standard twelve-folder template. |
| **Shared with me** | Things colleagues shared with you specifically. |
| **Recent**, **Starred** | Shortcuts back to what you were doing. |
| **Pending reviews**, **Approved** | Work waiting on you, and work that has been signed off. |
| **Archive**, **Trash** | Finished with, and deleted. Both recoverable. |

Project drives come with the standard structure — `01_Project Overview` through
`12_Archived Files`. Use it. It is the reason somebody can find your data in three years.

---

## Uploading

Drag files or whole folders onto the file list, or use **Upload**. Large files upload in
chunks and survive a dropped connection — if it fails, retry rather than starting over.

An upload can be refused for reasons that are all deliberate:

- **"Files must have a file extension"** — the extension determines how the file is
  handled. Add one.
- **The type is not allowed** — including when a file's *contents* do not match its name.
  A `.pdf` that is actually a program is held for review rather than stored.
- **Quota exceeded** — yours or the department's. Empty the trash or ask an administrator.
- **"The server is low on storage"** — not your fault, and an administrator has already
  been alerted.

---

## Research metadata — the bit that pays off later

When you upload, you can attach: project, experiment, sample ID, protocol, instrument,
organism, batch, research date, category, tags, confidentiality.

**None of it is mandatory and all of it is worth it.** Metadata is how you find a file
without remembering where you put it. "Every CSV from experiment EXP-2026-014" is a
search; "which folder did I use in March" is a memory test.

Sample IDs in particular become links: click one and you get every file that touched that
sample, wherever it was filed.

---

## Finding things

Search covers file and folder names, project and experiment codes, sample IDs, tags,
metadata, researcher, department, category, and every status field. Narrow with the filter
chips; save a search you run often.

**You only ever see what you have access to.** Search is not a way around permissions —
restricted files do not appear, and they are not counted in the totals either.

---

## Versions

Uploading a file with the same name as an existing one creates a **new version**, not a
duplicate and not an overwrite.

- Every previous version stays downloadable, for ever.
- Each version records who uploaded it, when, and their note. Write the note.
- **Restoring an old version creates a new version** containing those bytes. History is
  never rewritten — you can always see that the restore happened.
- Once a version is approved it is read-only. Any change after that is a new version, and
  the approved one stays exactly where it is.

This is the answer to "which one is the current file?".

---

## Sharing

Share with individual colleagues, a department, a project team, or a role. Access levels:
Viewer, Commenter, Editor, Reviewer, Approver, Manager.

There are no public links and no "anyone with the link". Every access is attributable to
a named employee. Folder permissions are inherited by their contents, and revoking access
takes effect immediately — not at the next sign-in.

---

## Review and approval

**Draft → Submitted for review → Changes requested → Approved → Final → Archived**

Submit a file for review and pick a reviewer. They can comment, request changes, approve
or reject — always against **a specific version**, which is recorded, so "approved" is
never ambiguous about what was approved.

Approved files become read-only. Editing one creates a new version that starts as a draft
again. That is intentional: it means an approval can never be quietly replaced.

Occasionally a file you had approved will come back as **Changes requested**, with a note
saying the document changed after it was approved. That happens when the document itself was
edited somewhere outside this application — a Google Doc someone opened and typed in, for
instance. Nothing is lost: the earlier approval, who gave it and when, stays in the file's
history. It simply no longer covers what the document says now, so it needs reviewing again.

---

## Comments

Comment on a file, reply in a thread, mention a colleague with `@` to notify them.
Comments never change the file — they are a conversation next to it, not an edit to it.

---

## Working with several files at once

Tick the checkbox on any row — or Ctrl/⌘-click, or Shift-click to take a run of them — and
a bar appears offering **Move**, **Star** and **Move to trash** for everything selected.
Ctrl/⌘+A takes the whole page.

A bulk action tells you the truth about what happened. "Moved 12 of 14" means two were
refused, usually because you do not have permission on them or because they are approved
and therefore read-only. It does not quietly skip them.

**Right-click** any file or folder for its full list of actions. **Drag** items onto a
folder to move them there, or onto a folder name in the path bar at the top to move them
up a level.

Press **?** anywhere for the full list of shortcuts.

---

## Deleting

Deleting a file takes effect immediately and offers **Undo** for a few seconds — that is
faster and safer than a confirmation box you would learn to click through without reading.
Deleting a *folder* still asks first, because everything inside it goes too and that is not
visible from the row you clicked.

**Trash** is recoverable for 30 days, then permanently purged. Restoring a folder brings
back exactly what went to the trash with it — not things you deleted separately
beforehand. Files and folders both appear there, and both restore to where they came from.

**Archive** is for finished work you want out of the way but kept. Nothing expires there.

---

## Things worth knowing

- **Every action is recorded** — uploads, downloads, previews, shares, permission
  changes, approvals, deletions. Not to police you: so that when somebody asks "who
  approved this and when", the answer exists.
- **Confidential files** are visible only to people explicitly granted access, and their
  existence is not disclosed to anyone else.
- **Copying a file does not copy who it was shared with.** The copy starts with the
  permissions of where it lands. This prevents copying from smuggling access into a place
  it was never granted.
- **Nothing is stored in your browser.** Files live on the company server. Clearing your
  browser data loses nothing.

---

## Getting help

Contact your administrator for account or access problems. If a file will not open or
download, say what you clicked and what it said — the audit log will show exactly what
happened.
