import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';

import './globals.css';
import { Toaster } from 'sonner';
import { ThemeProvider } from '@/components/providers/theme-provider';
import { QueryProvider } from '@/components/providers/query-provider';
import { DevSwitcherMount } from '@/components/dev/dev-switcher-mount';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });

export const metadata: Metadata = {
  title: {
    default: 'Biotech Research Drive',
    template: '%s · Biotech Research Drive',
  },
  description: 'Secure internal platform for company R&D data: upload, organize, review and version research files.',
  robots: { index: false, follow: false },
  icons: { icon: '/favicon.svg' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0b1220' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} font-sans`}>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
        >
          Skip to content
        </a>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <QueryProvider>
            {children}
            {/* Drive operations are mostly silent on success; a toast is the only
                confirmation that a move or a copy actually happened. */}
            <Toaster position="bottom-right" closeButton richColors />
            {/* Development builds only — renders nothing in production. Mounted here so
                it is present on the login screen too, which is exactly where switching
                accounts is most useful. Inside QueryProvider because it uses the same
                session query the rest of the app does. */}
            <DevSwitcherMount />
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
