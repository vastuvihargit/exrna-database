/**
 * Build metadata reported by `/api/version`.
 *
 * This lived in the navigation config while the sidebar still showed "available in
 * Phase N" badges. Those badges were internal roadmap vocabulary shown to employees, so
 * they are gone; the number stays here because release tooling and the smoke tests read
 * it, and because a route handler importing a UI module to find it was always backwards.
 */
export const CURRENT_PHASE = 11;
