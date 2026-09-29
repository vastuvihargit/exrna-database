// `npm run build`, made safe for Cloudflare Workers Builds.
//
// Workers Builds runs `npm run build` then `npx wrangler deploy` unless the dashboard says
// otherwise. A plain `next build` leaves no `.open-next/worker.js` for `cloudflare-worker.ts`
// to wrap, and without BUILD_TARGET=cloudflare the argon2 native addon is not aliased away
// (next.config.ts), so the OpenNext bundle fails on its `.node` files. Inside Workers
// Builds (WORKERS_CI=1) this therefore runs the Worker build instead.
//
// OpenNext itself calls `npm run build` for the Next.js step, with BUILD_TARGET=cloudflare
// already set by `cf:build` — that inner call falls through to `next build`, so there is no
// recursion. Everywhere else (local, CI, the Node deployment) this is exactly `next build`.
import { spawnSync } from 'node:child_process';

const workerBuild = process.env.WORKERS_CI === '1' && process.env.BUILD_TARGET !== 'cloudflare';
const command = workerBuild ? 'npm run cf:build' : 'next build';

if (workerBuild) console.log('Cloudflare Workers Builds detected: running `npm run cf:build`.');

const result = spawnSync(command, { stdio: 'inherit', shell: true });
process.exit(result.status ?? 1);
