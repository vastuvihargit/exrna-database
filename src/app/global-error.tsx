'use client';

/**
 * Last-resort boundary: catches failures in the root layout itself, so it must render
 * its own <html>/<body> and cannot rely on providers or shared components.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          display: 'flex',
          minHeight: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
          margin: 0,
          padding: '1.5rem',
        }}
      >
        <div style={{ maxWidth: '28rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Application error</h1>
          <p style={{ marginTop: '0.5rem', color: '#64748b', fontSize: '0.875rem' }}>
            The application failed to start. Please contact your administrator.
          </p>
          {error.digest ? (
            <p style={{ marginTop: '0.75rem', fontFamily: 'monospace', fontSize: '0.75rem', color: '#64748b' }}>
              Reference: {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: '1.5rem',
              padding: '0.5rem 1rem',
              borderRadius: '0.375rem',
              border: '1px solid #cbd5e1',
              background: '#0f766e',
              color: 'white',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
