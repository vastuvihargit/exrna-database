# 08 — Security Threat Model

Scope: the internal Biotech Research Drive, its Node app, MongoDB, and the private file volume.
Method: STRIDE per component, plus explicit abuse cases drawn from the brief's test requirements.

## Assets, ranked

| # | Asset | Why it matters |
|---|---|---|
| A1 | Confidential/restricted R&D files (raw data, protocols, unpublished results) | IP loss is existential; the reason this system exists |
| A2 | Approval records & version history | Their integrity is what makes "the approved version" meaningful |
| A3 | Audit logs | Tampering destroys accountability for A1 and A2 |
| A4 | Credentials & sessions | Gateway to everything above |
| A5 | Availability of the file volume | Single-server storage; loss without backup is unrecoverable |
| A6 | Metadata (project/experiment structure) | Reveals research direction even without file bytes |

## Trust boundaries

```
Internet ──[TLS/Nginx]── App container ──[network]── MongoDB
                              │
                              └──[filesystem]── /data volume
Employee browser  = untrusted input, semi-trusted actor
Employee (authenticated) = trusted to their scope only — the insider is a real threat here
Worker container  = same trust as app; processes hostile file content → strongest sandbox needs
Google Drive API  = external, read-only, treated as untrusted content source
```

## STRIDE

### Spoofing

| Threat | Control |
|---|---|
| Credential stuffing / brute force | Argon2id, per-IP + per-email rate limits, lockout with exponential backoff, generic errors, uniform response timing |
| Session theft (XSS) | `HttpOnly` cookies (JS cannot read them), strict CSP, no `dangerouslySetInnerHTML` outside a sanitized-HTML preview component, React escaping |
| Session fixation | Token rotated on login and on privilege change |
| OAuth code interception / CSRF | PKCE + `state` + nonce, exact redirect-URI match, `id_token` signature/iss/aud/exp verified |
| Domain spoofing (`user@company.com.evil.com`) | Domain compared against a parsed suffix after the final `@`, exact match against the allow-list — never `endsWith` |
| Non-company Google account | `email_verified` required **and** domain allow-list; `hd` treated as a hint only |
| Personal email registration | No public registration route exists; `ALLOW_AUTO_PROVISIONING=false` |

### Tampering

| Threat | Control |
|---|---|
| Modifying an approved version's bytes | Bytes are immutable (exclusive-create), `isLocked`, and every change forces a new version |
| Editing audit logs | Append-only repository, no update/delete model methods, DB user restricted to `insert`/`find` on `auditLogs`, integrity sweep for gaps |
| NoSQL injection (`{$ne:null}` as a password/id) | Zod parses **before** any query; ids coerced with `ObjectId.isValid`; no user object is ever spread into a filter; Mongoose `sanitizeFilter` on |
| Mass assignment (`isSuperAdmin:true` in a PATCH) | Zod `.strict()` on every input schema; explicit field allow-lists in services |
| Path traversal on upload/download | `assertSafeKey` allow-list regex + `resolveKey` prefix check + `fstat` regular-file check |
| Prototype pollution via JSON body | `__proto__`/`constructor`/`prototype` keys rejected by Zod strict parsing |
| Header injection via filename | CR/LF/quote stripping + RFC 5987 encoding in `Content-Disposition` |
| ZIP-slip on import | Archives are never extracted in the MVP |
| Client-supplied permissions | The frontend's role data is display-only; every route re-derives the actor server-side |

### Repudiation

Every sensitive action writes an audit row with actor, email, role keys, IP, user-agent, request id,
before/after values, and a mandatory `reason` for purge/permission-change/role-change. Approval
decisions additionally store IP and user-agent on the decision itself. Clock is server-side UTC.

### Information disclosure — *the highest-risk category for this product*

| Threat | Control |
|---|---|
| Guessing a file id and downloading (IDOR) | Every by-id route runs the visibility filter first; unauthorized → 404 |
| 403-vs-404 oracle | Invisible resources always 404; 403 only after visibility is proven |
| Search leaking restricted filenames/snippets | Permission filter is part of the Mongo query, never a post-filter; no counts, no facets, no highlights computed on invisible docs |
| Cross-department access | `departmentId`/`projectId`/ACL branches in `visibilityFilter`; dedicated test suite |
| Physical path disclosure | DTO mappers strip `storageKey`; response-shape test greps for path patterns; logger redacts |
| Direct static access to `/data` | No Nginx location, no Next static route; roots asserted outside the app directory at boot |
| Stored XSS via SVG/HTML preview | SVG rasterized or download-only; HTML never previewed; all previews `nosniff` + sandbox CSP |
| Error messages leaking internals | Unknown errors → generic message + request id; stack traces only in logs |
| Notification leaking a restricted title | Notifications are generated after a permission check on the recipient |
| Autocomplete leaking names | Suggestion endpoint uses the same visibility filter |
| Timing oracle on login | Dummy Argon2 verify for unknown users |
| Metadata leak in `Recent`/`Shared` | Same filter as search |

### Denial of service

| Threat | Control |
|---|---|
| Huge uploads exhausting disk | `MAX_UPLOAD_SIZE_MB`, per-user/dept/org quotas, Nginx `client_max_body_size`, disk-headroom check that rejects uploads below a floor |
| Memory exhaustion | Everything streams; no `arrayBuffer()`; chunk size fixed; parsers (CSV/XLSX) row-capped and run in the worker |
| Zip bomb / decompression | Archives never expanded |
| Regex DoS in search | User input never becomes a raw regex; suggestions use an anchored, escaped, length-capped prefix only |
| Unbounded queries | Every list has a hard page cap (100) and an index |
| Preview-render bomb (malicious DOCX) | Worker-only, no network, CPU/memory cgroup limits, hard timeout, failure marks `previewStatus:'failed'` |
| Abandoned uploads filling `/data` | TTL + sweeper |
| Login flooding | Rate limits + Nginx limit zones |

### Elevation of privilege

| Threat | Control |
|---|---|
| Granting yourself a higher role | Role `rank` check + "cannot grant a permission you lack" |
| Self-approval | Reviewer ≠ uploader, enforced server-side |
| Approving a version you never saw | `review.versionId` must equal `file.currentVersionId` → else 409 `VERSION_MOVED` |
| Editing your own audit trail | No write API |
| Deactivated user retaining access | Status re-checked on **every** request; deactivation revokes all sessions |
| Stale permission after revoke | No cross-request permission cache; ACL version counter |
| RCE via uploaded file | Files stored without executable extensions, `0640`, `noexec` mount, never `exec`'d, never served with an executable content type |
| Container escape from rendering | Worker: non-root, read-only rootfs except `/tmp` and `/data`, no network, dropped capabilities |

## Abuse cases → required tests

| # | Abuse case | Test (Phase) |
|---|---|---|
| AC1 | Dept-B scientist requests a Dept-A restricted file by id | 404, audited denial (3, 5) |
| AC2 | Enumerate `/api/files/{random ObjectId}` | Always 404, rate-limited, no timing difference (5, 11) |
| AC3 | `storageKey=../../../../etc/passwd` in every storage-touching path | `INVALID_KEY`, nothing read (4, 11) |
| AC4 | Deactivate a user mid-session, replay their cookie | 401 on the next request (2) |
| AC5 | Search for a restricted project's code word | Zero results, no count leak (6) |
| AC6 | Upload a new version over an approved file expecting silent replacement | New version created; approved version byte-identical and still resolvable (6, 8) |
| AC7 | Upload `payload.pdf` whose bytes are a PE/ELF binary | 415, quarantine deleted (4) |
| AC8 | `docker compose down && up`, then fetch a previously uploaded file | Byte-identical, checksum matches (1, 4, 11) |
| AC9 | Kill the app mid-upload | No `files`/`fileVersions` row; quarantine swept (4) |
| AC10 | Finalize the same upload session twice concurrently | One file, one version (4) |
| AC11 | PATCH `{isSuperAdmin:true}` on own profile | 422 strict-schema rejection (2) |
| AC12 | Login with `alice@company.com.attacker.io` | Domain rejected (2) |
| AC13 | POST without CSRF token from another origin | 403 (2, 11) |
| AC14 | Reviewer approves their own upload | 403 (8) |
| AC15 | Restore a backup into a clean volume and diff checksums | All files recovered (11) |
| AC16 | Request a preview of an uploaded SVG containing `<script>` | Not served as `image/svg+xml`; no script executes (5) |
| AC17 | Send `{"email":{"$ne":null},"password":{"$ne":null}}` to login | 422, never a successful auth (2) |
| AC18 | Move a folder into its own descendant | 409 `CIRCULAR_MOVE`, tree intact (3) |

## Secrets & configuration

- No secrets in the repo; `.env` is git-ignored, `.env.example` holds empty keys only.
- `AUTH_SECRET`/`SESSION_SECRET` ≥ 32 bytes, validated at boot, rotatable (rotation invalidates sessions by design).
- Secrets are injected as Docker environment/secret files, never baked into images.
- CI runs `gitleaks`; a pre-commit hook blocks obvious key patterns.
- MongoDB requires auth even inside the compose network, with a least-privilege application user
  (and a separate audit-writer user restricted to `insert`+`find` on `auditLogs`).

## HTTP hardening (Nginx + Next middleware)

```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self';
  connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
X-Frame-Options: DENY
```

`'unsafe-inline'` for styles is a Tailwind/shadcn concession; scripts have no such exception.
Preview responses override CSP with `default-src 'none'; sandbox`.

## Residual risks (accepted, with mitigations)

| Risk | Why accepted | Mitigation |
|---|---|---|
| Malicious insider with legitimate download rights exfiltrates files | Cannot be prevented by access control alone | Full download audit, per-user rate limits, anomaly review in the admin panel; DLP/watermarking is a Phase 12 option |
| Single-server storage loss | Chosen architecture | Mandatory off-server encrypted backup + tested restore + checksum sweeps |
| No AV scanning until Phase 11 | Sequencing | Quarantine + type allow-list + no execution + `noexec` mount |
| Office rendering parses hostile input | Feature requirement | Worker isolation, no network, resource caps, timeouts |
| MongoDB compromise reveals metadata | Same trust zone as the app | Network-isolated, authenticated, encrypted backups; disk encryption recommended on the host |
