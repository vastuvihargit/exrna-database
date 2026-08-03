# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Biotech Research Drive — multi-stage build
# The runtime image is a Next.js standalone bundle running as a non-root user.
# Application data NEVER lives in the image: it is on the mounted /data volume.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: runtime dependencies ────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

# ── Stage 2: build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY . .

ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
ENV NEXT_TELEMETRY_DISABLED=1

# The build must not depend on real secrets; these placeholders only satisfy the
# env schema during `next build` and are replaced at runtime by the compose env-file.
ENV NODE_ENV=production \
    APP_URL=https://build.invalid \
    MONGODB_URI=mongodb://placeholder:27017/build \
    AUTH_SECRET=build-time-placeholder-value-not-a-secret-32 \
    SESSION_SECRET=build-time-placeholder-value-not-a-secret-33 \
    COMPANY_EMAIL_DOMAINS=example.com \
    LOCAL_STORAGE_ROOT=/data/storage \
    TEMP_UPLOAD_ROOT=/data/temp \
    QUARANTINE_ROOT=/data/quarantine \
    PREVIEW_ROOT=/data/previews \
    EXPORT_ROOT=/data/exports

RUN npm run build

# ── Stage 3: runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN apk add --no-cache curl tini \
 && addgroup -g 1000 -S nodejs \
 && adduser -u 1000 -S nextjs -G nodejs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Mount point for the persistent volume. Created here so the container can start
# even before the volume is attached (the readiness probe then reports the problem).
RUN mkdir -p /data/storage /data/temp /data/quarantine /data/previews /data/exports \
 && chown -R nextjs:nodejs /data \
 && chmod -R 750 /data

USER nextjs
EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

# tini reaps zombies and forwards SIGTERM so in-flight uploads shut down cleanly.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]

# ── Stage 4: maintenance / scheduler ─────────────────────────────────────────
# The runtime image above is a standalone bundle: no scripts/, no tsx, no dev
# dependencies. The scheduled jobs (health monitor, trash purge, upload cleanup,
# storage integrity) therefore cannot run in it.
#
# This stage carries the source and the tooling so those jobs execute the exact same
# code the test suite covers, rather than a reimplementation in shell. It is bigger
# than the runtime image and never serves traffic — it has no port and no HTTP server.
FROM node:22-alpine AS maintenance
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

RUN apk add --no-cache libc6-compat tini dcron su-exec \
 && addgroup -g 1000 -S nodejs \
 && adduser -u 1000 -S nextjs -G nodejs

COPY package.json package-lock.json* ./
# Dev dependencies are needed here: tsx runs the TypeScript jobs directly.
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY docker/scheduler/crontab /usr/local/etc/scheduler-crontab
COPY docker/scheduler/entrypoint.sh /usr/local/bin/scheduler-entrypoint.sh
RUN chmod +x /usr/local/bin/scheduler-entrypoint.sh

RUN mkdir -p /data && chown -R nextjs:nodejs /data /app

# Runs as root: BusyBox crond needs it. The jobs themselves drop to nextjs via su-exec
# in the entrypoint's crontab lines.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/usr/local/bin/scheduler-entrypoint.sh"]
