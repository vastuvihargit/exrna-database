import { isDevToolingEnabled } from '@/server/config/dev-mode';

/**
 * Mounts the 🛠 DEV switcher, or nothing at all.
 *
 * A **server** component, which is the whole point: the decision is made on the server,
 * where `NODE_ENV` and `ENABLE_DEV_SWITCHER` are real values, and a production render
 * emits no markup — there is nothing for the client to hydrate and no request for it to
 * make. A `useEffect` that checked the environment in the browser would ship the panel to
 * production and merely decline to draw it.
 *
 * Keeping the panel's code out of the production bundle takes a second mechanism.
 * Dead-code elimination is not enough on its own: webpack builds the module graph — and
 * emits the chunk — before it minifies, so an `import()` sitting under a statically false
 * branch still ships. `next.config.ts` therefore aliases `@/components/dev/dev-switcher`
 * to `dev-switcher.stub.tsx` in production builds, and the real panel is never resolved
 * at all. Measured, not assumed: the build is grepped for the panel's own strings.
 *
 * Layers, in order of what actually protects what:
 *   • `/api/dev/*` route files are named `route.dev.ts` and are not compiled at all in a
 *     production build (see `pageExtensions` in next.config.ts) — the endpoints do not
 *     exist in the artifact.
 *   • `assertDevToolingEnabled()` guards the same routes at runtime, which is what covers
 *     a non-production build that has the feature switched off.
 *   • This component keeps the panel out of the production bundle and off the page.
 */
export async function DevSwitcherMount() {
  if (process.env.NODE_ENV === 'production') return null;
  if (!isDevToolingEnabled()) return null;

  // Imported through the `@/` alias rather than a relative path so next.config.ts has a
  // stable specifier to redirect in production builds.
  const { DevSwitcher } = await import('@/components/dev/dev-switcher');
  return <DevSwitcher />;
}
