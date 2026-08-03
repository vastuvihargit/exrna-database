'use client';

/**
 * How the shell asks the open folder view to act.
 *
 * The New menu lives in the sidebar, beside the folder browser rather than inside it, so
 * it cannot know which folder is on screen. It announces an intent instead and a mounted
 * browser that is able to satisfy it claims it. On Home, Trash, Search or Admin nothing
 * claims it, and the caller falls back to My Drive — always a valid place to put a file.
 *
 * Both events are dispatched synchronously, which is what makes this usable from a click
 * handler: the answer is available before the handler returns, so the browser's user
 * activation is still live and a file picker will still open.
 */

export const NEW_FOLDER_EVENT = 'drive:new-folder';
export const UPLOAD_TARGET_EVENT = 'drive:upload-target';

/**
 * Marks a drag as one of our own rows rather than files from the desktop.
 *
 * The upload dropzone only reacts to drags whose types include `Files`, so an internal
 * drag passes straight through it without arming the "drop to upload" overlay. During
 * `dragover` the browser refuses to reveal drag *data* — only the list of types — which
 * is exactly why the marker has to be a type rather than a payload.
 */
export const DRIVE_DRAG_MIME = 'application/x-drive-items';

export interface UploadTargetDetail {
  /** Filled in by an open folder browser the viewer is allowed to upload to. */
  folderId: string | null;
}

/** True when an open folder view answered by opening its own New folder dialog. */
export function requestNewFolder(): boolean {
  if (typeof window === 'undefined') return false;
  return !window.dispatchEvent(new CustomEvent(NEW_FOLDER_EVENT, { cancelable: true }));
}

/** The folder currently on screen, or null when there is none the viewer can write to. */
export function resolveOpenFolderTarget(): string | null {
  if (typeof window === 'undefined') return null;
  const detail: UploadTargetDetail = { folderId: null };
  window.dispatchEvent(new CustomEvent<UploadTargetDetail>(UPLOAD_TARGET_EVENT, { detail }));
  return detail.folderId;
}
