/**
 * Production stand-in for the 🛠 DEV switcher panel.
 *
 * `next.config.ts` aliases `@/components/dev/dev-switcher` to this file in production
 * builds, so the real panel's code is never resolved and never reaches a bundle.
 *
 * Why a stub rather than aliasing the module to `false`: an empty module makes the
 * imported binding `undefined`, and "component is undefined" is a confusing crash to
 * debug if the guard above it is ever changed. A component that renders nothing fails
 * safely instead — and it is deliberately *not* a client component, so it adds nothing
 * to the browser bundle either.
 */
export function DevSwitcher() {
  return null;
}
