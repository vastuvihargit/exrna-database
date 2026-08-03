# Secrets mounted as files

This directory is bind-mounted read-only at `/run/secrets` in the `app` and `scheduler`
containers (production compose only).

Things that belong here rather than in the environment: anything multi-line, and anything
that must not appear in `docker inspect`, a process listing, or a crash report that dumps
the environment.

## `google-drive-key.pem`

The Google service-account private key, when `GOOGLE_DRIVE_STORAGE_ENABLED=true`.

```bash
# From the JSON key file Google gives you:
jq -r .private_key service-account.json > docker/secrets/google-drive-key.pem
chmod 400 docker/secrets/google-drive-key.pem
```

Then in `.env.production`:

```env
GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY_FILE=/run/secrets/google-drive-key.pem
```

It takes precedence over the inline `GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY`, so a stale
inline copy can never win over the mounted one. Leave the inline variable unset in
production.

**Nothing in this directory is committed.** `.gitignore` excludes everything here except this
file. An empty directory is the correct state for a deployment that does not use Google Drive.
