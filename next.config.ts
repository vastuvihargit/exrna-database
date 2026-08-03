import path from 'path';
import type { NextConfig } from 'next';

/**
 * Security headers applied to every route.
 *
 * These are configured headers, which Next applies *after* a route handler has built its
 * response — so a header set here wins over the same header set in code. That matters for
 * exactly one route: the inline preview endpoint carries its own sandbox CSP, and the
 * application policy below would both replace it and, through `frame-ancestors 'none'`,
 * stop the preview being embedded in our own viewer. The preview path is therefore served
 * the framing- and CSP-free subset, and sets those two headers itself
 * (see `server/http/file-response.ts` and docs/phase-0/08-security-threat-model.md).
 */
const baseSecurityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
];

const documentSecurityHeaders = [
  ...baseSecurityHeaders,
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      // 'unsafe-eval' is required by React's dev refresh only; it is dropped in production below.
      process.env.NODE_ENV === 'production'
        ? "script-src 'self'"
        : "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' blob: data:",
      "media-src 'self' blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
  },
];

/** `/api/files/{id}/preview` — the one route that owns its CSP. */
const PREVIEW_ROUTE = '/api/files/:fileId/preview';
const EXCEPT_PREVIEW_ROUTE = '/((?!api/files/[^/]+/preview).*)';

/**
 * Which files Next will treat as routes.
 *
 * `.dev.ts` / `.dev.tsx` are recognised **only outside production**. A file named
 * `route.dev.ts` is therefore a working route handler on a developer machine and, in a
 * production build, not a route at all — Next never resolves it, so it is never
 * compiled, never bundled and never present in the deployed artifact.
 *
 * This is the difference between a route that exists and refuses (`assertDevToolingEnabled`
 * returning 404) and one that was never built. Both are correct; only the second one is
 * absent from the production bundle, and for an endpoint that can mint a session without
 * a password, absent is worth the extra naming convention.
 *
 * The runtime gate stays regardless. Excluding the file protects the production artifact;
 * the gate protects every other non-production environment — a staging box running a
 * development build still needs `ENABLE_DEV_SWITCHER=false` to be honoured.
 */
const BASE_PAGE_EXTENSIONS = ['tsx', 'ts', 'jsx', 'js'];
const pageExtensions =
  process.env.NODE_ENV === 'production'
    ? BASE_PAGE_EXTENSIONS
    : ['dev.tsx', 'dev.ts', ...BASE_PAGE_EXTENSIONS];

const nextConfig: NextConfig = {
  // Required for the Docker runtime image: emits a self-contained server bundle.
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  pageExtensions,

  // Mongoose must never be bundled into the client or edge runtime.
  serverExternalPackages: ['mongoose', 'pino', 'pino-pretty'],

  eslint: {
    dirs: ['src', 'scripts', 'tests'],
  },

  /**
   * Replaces the 🛠 DEV switcher panel with a render-nothing stub in production builds.
   *
   * The route files are excluded by `pageExtensions` above, which is enough for the
   * endpoints. The panel is a component, not a route, so it needs this: dead-code
   * elimination alone does not remove it, because webpack builds the module graph and
   * emits the chunk *before* it minifies — an `import()` under a statically false branch
   * still ships. Redirecting the specifier means the real module is never resolved.
   *
   * Keyed on NODE_ENV rather than webpack's `dev` flag so it matches `pageExtensions`
   * exactly. One rule, one condition: a build is either a production build — no dev
   * routes, no dev panel — or it is not.
   */
  webpack: (config, { webpack }) => {
    if (process.env.NODE_ENV === 'production') {
      // `resolve.alias` does not work for this: Next resolves the `@/*` tsconfig paths
      // through a resolve *plugin* that runs before webpack's alias stage, so an alias
      // keyed on `@/components/…` is never consulted. Replacing the module at creation
      // time sidesteps resolution order entirely.
      //
      // The `$` anchor matters — without it the pattern would also swallow
      // `dev-switcher-mount`, and the mount is what decides not to render.
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(
          /[\\/]components[\\/]dev[\\/]dev-switcher$/,
          path.resolve(__dirname, 'src/components/dev/dev-switcher.stub.tsx'),
        ),
      );
    }
    return config;
  },

  async headers() {
    const rules = [
      { source: EXCEPT_PREVIEW_ROUTE, headers: documentSecurityHeaders },
      // The preview route keeps the headers that do not conflict; it sets its own
      // sandbox CSP and `Referrer-Policy: no-referrer` in the response itself.
      { source: PREVIEW_ROUTE, headers: baseSecurityHeaders },
    ];

    // HSTS only makes sense over TLS, which the reverse proxy terminates in production.
    if (process.env.NODE_ENV === 'production') {
      rules.push({
        source: '/:path*',
        headers: [
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
        ],
      });
    }

    return rules;
  },
};

export default nextConfig;
