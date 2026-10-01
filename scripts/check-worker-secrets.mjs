// Refuses a Worker deploy that would boot without its secrets.
//
//   node scripts/check-worker-secrets.mjs staging
//
// `wrangler deploy` replaces every plain-text variable with the `vars` in wrangler.jsonc, so a
// value typed into the dashboard as a *variable* is deleted by the next deploy — and the Worker
// then refuses to boot. Secrets survive deploys. This asks Cloudflare which secrets exist (names
// only; wrangler never returns values) and stops the deploy before it happens if a required one
// is missing, instead of after, with a Worker that 500s.
//
// Required names are per environment and follow the sign-in mode in wrangler.jsonc: staging runs
// AUTH_PROVIDER=google_oauth, whose client ID and APP_URL are vars, and must have no Access secrets.
import { spawnSync } from 'node:child_process';

const REQUIRED = {
  staging: [
    'AUTH_SECRET',
    'SESSION_SECRET',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'GOOGLE_SHARED_DRIVE_ID',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL',
    'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY',
  ],
};
// With AUTH_PROVIDER=google_oauth the Worker refuses to boot if these are set.
const FORBIDDEN = { staging: ['CF_ACCESS_TEAM_DOMAIN', 'CF_ACCESS_AUD'] };

const environment = process.argv[2];
if (!REQUIRED[environment]) {
  console.error(`Usage: node scripts/check-worker-secrets.mjs <${Object.keys(REQUIRED).join('|')}>`);
  process.exit(2);
}

const result = spawnSync('npx', ['wrangler', 'secret', 'list', '--env', environment, '--format', 'json'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
if (result.status !== 0) {
  console.error(result.stderr || result.stdout);
  console.error(`Could not list the ${environment} Worker's secrets; refusing to deploy.`);
  process.exit(1);
}

let names;
try {
  const json = result.stdout.slice(result.stdout.indexOf('['));
  names = new Set(JSON.parse(json).map((secret) => secret.name));
} catch {
  console.error(`Unexpected output from \`wrangler secret list\`; refusing to deploy.`);
  process.exit(1);
}

const missing = REQUIRED[environment].filter((name) => !names.has(name));
const forbidden = FORBIDDEN[environment].filter((name) => names.has(name));

if (missing.length > 0) {
  console.error(
    `${environment}: missing Worker secrets: ${missing.join(', ')}\n` +
      `Set each with \`npx wrangler secret put <NAME> --env ${environment}\`. A dashboard *variable* ` +
      `of the same name does not count: the next deploy deletes it.`,
  );
}
if (forbidden.length > 0) {
  console.error(
    `${environment}: these secrets must not exist with AUTH_PROVIDER=google_oauth: ${forbidden.join(', ')}\n` +
      `Remove each with \`npx wrangler secret delete <NAME> --env ${environment}\`.`,
  );
}
if (missing.length > 0 || forbidden.length > 0) process.exit(1);

console.log(`${environment}: all ${REQUIRED[environment].length} required Worker secrets are present.`);
