'use client';

import { createContext, useContext, type ReactNode } from 'react';

import { UploadTray } from '@/components/drive/upload-tray';
import { useUploader, type Uploader } from '@/hooks/use-upload';

const UploadContext = createContext<Uploader | null>(null);

/**
 * One uploader for the whole signed-in session.
 *
 * It used to be created inside the folder browser, which meant the browser's unmount
 * cleanup aborted every transfer still in flight the moment the user navigated to
 * another page — the exact thing the tray tells them will not happen. Mounted here it
 * outlives navigation, and "upload" can be offered from anywhere in the shell instead of
 * only from inside an open folder.
 *
 * The tray is rendered here too, for the same reason: it must keep reporting progress on
 * pages that have no folder view at all.
 */
export function UploadProvider({ children }: { children: ReactNode }) {
  const uploader = useUploader();

  return (
    <UploadContext.Provider value={uploader}>
      {children}
      <UploadTray uploader={uploader} />
    </UploadContext.Provider>
  );
}

export function useUploadContext(): Uploader {
  const uploader = useContext(UploadContext);
  if (!uploader) {
    throw new Error('useUploadContext must be used inside <UploadProvider>');
  }
  return uploader;
}
