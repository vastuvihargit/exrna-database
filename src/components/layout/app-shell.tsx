import type { ReactNode } from 'react';
import { UploadProvider } from '@/components/providers/upload-provider';
import { Header } from './header';
import { Sidebar } from './sidebar';

/**
 * The authenticated application shell: fixed header, persistent sidebar on desktop,
 * scrollable content region.
 *
 * `UploadProvider` wraps the whole shell rather than the folder view, so a transfer
 * survives navigation and the New menu in the sidebar can start one from any page.
 */
export function AppShell({ children, appName }: { children: ReactNode; appName: string }) {
  return (
    <UploadProvider>
      <div className="flex min-h-screen flex-col">
        <Header appName={appName} />
        <div className="flex flex-1 overflow-hidden">
          <Sidebar className="hidden lg:flex" />
          <main id="main-content" className="scrollbar-thin flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-7xl p-6">{children}</div>
          </main>
        </div>
      </div>
    </UploadProvider>
  );
}
