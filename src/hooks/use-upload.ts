'use client';

/**
 * Client side of the upload flow (docs/phase-0/06-flows.md).
 *
 *   authorize → send bytes → finalize
 *
 * Three things drive the shape of this file:
 *
 * 1. `fetch` cannot report upload progress, so the byte-sending step uses XHR. That is
 *    the only reason XHR appears anywhere in this codebase.
 * 2. Large files go chunked, and a chunked session is *resumable*: a retry asks the
 *    server which chunks it already holds and sends only the rest, rather than starting
 *    a 2 GB upload again because the last 8 MB failed.
 * 3. Finalize is safe to call twice, so a retry after a timeout at that step returns the
 *    file the first call created instead of a duplicate.
 *
 * Nothing here decides whether an upload is allowed — the authorize step does, on the
 * server, before a single byte is sent.
 *
 * The queue lives in refs rather than state. It is mutated from async callbacks that must
 * see each other's writes immediately, which is exactly what React state does not
 * promise; `items` is a render-only mirror.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, apiRequest } from '@/lib/api-client';

/** Above this, upload in resumable chunks. Below it, one streamed request is cheaper. */
const CHUNKED_THRESHOLD_BYTES = 32 * 1024 * 1024;

/** How many files move at once. Enough to saturate a link, few enough to stay orderly. */
const MAX_CONCURRENT = 3;

const CSRF_COOKIE = 'bd_csrf';

const IN_FLIGHT: UploadStatus[] = ['queued', 'authorizing', 'uploading', 'finalizing'];
const SETTLED: UploadStatus[] = ['done', 'failed', 'cancelled'];

export type UploadStatus =
  | 'queued'
  | 'authorizing'
  | 'uploading'
  | 'finalizing'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface UploadItem {
  /** Client-side id; the server session id appears as `sessionId` once authorized. */
  id: string;
  name: string;
  size: number;
  folderId: string;
  status: UploadStatus;
  /** 0–100, byte-accurate while sending. */
  progress: number;
  error?: string;
  /** Present once authorized — the handle a resume or a cancel needs. */
  sessionId?: string;
  /** Present once finalized. */
  fileId?: string;
  /** Set when uploading a new version of an existing file. */
  targetFileId?: string;
  versionNote?: string;
}

interface UploadTicket {
  sessionId: string;
  chunkSize: number;
  totalChunks: number;
}

interface SessionStatus {
  sessionId: string;
  status: string;
  receivedChunks: number[];
  chunkSize: number;
  totalChunks: number;
}

export interface EnqueueOptions {
  folderId: string;
  /** Uploading a new version of this file rather than creating a new one. */
  targetFileId?: string;
  versionNote?: string;
}

function readCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.split('; ').find((entry) => entry.startsWith(`${CSRF_COOKIE}=`));
  return match ? decodeURIComponent(match.slice(CSRF_COOKIE.length + 1)) : null;
}

/**
 * PUT a body with progress reporting and cancellation.
 *
 * Resolves the unwrapped `data` and rejects with the same `ApiError` shape `apiRequest`
 * produces, so callers cannot tell which transport was used.
 */
function putWithProgress(
  url: string,
  body: Blob,
  options: {
    onProgress?: (loaded: number) => void;
    signal: AbortSignal;
    contentType?: string;
  },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const request = new XMLHttpRequest();
    request.open('PUT', url, true);
    request.withCredentials = true;
    request.setRequestHeader('Content-Type', options.contentType ?? 'application/octet-stream');

    const csrf = readCsrfToken();
    if (csrf) request.setRequestHeader('x-csrf-token', csrf);

    const onAbort = () => request.abort();
    options.signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => options.signal.removeEventListener('abort', onAbort);

    if (options.onProgress) {
      request.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) options.onProgress?.(event.loaded);
      });
    }

    request.addEventListener('load', () => {
      cleanup();
      const payload = (() => {
        try {
          return JSON.parse(request.responseText) as {
            data?: unknown;
            error?: { code: string; message: string; requestId?: string };
          };
        } catch {
          return null;
        }
      })();

      if (request.status >= 200 && request.status < 300 && !payload?.error) {
        resolve(payload?.data);
        return;
      }

      reject(
        new ApiError(
          payload?.error?.message ?? `Upload failed with status ${request.status}`,
          request.status,
          payload?.error?.code ?? 'UNKNOWN',
          undefined,
          payload?.error?.requestId,
        ),
      );
    });

    request.addEventListener('error', () => {
      cleanup();
      reject(new ApiError('The connection dropped during upload', 0, 'NETWORK'));
    });

    request.addEventListener('abort', () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    });

    request.send(body);
  });
}

/**
 * Where files go when the uploader is invoked from outside a folder view.
 *
 * My Drive, for the reason every drive picks it: it is the one folder every employee can
 * always write to. `/api/drives/my` creates the root the first time it is asked for, so
 * this also works for an account that has never opened their drive. The result is cached
 * under the same key `useMyDrive` uses, so resolving a target warms that page too.
 */
export function useResolveUploadTarget() {
  const queryClient = useQueryClient();

  return useCallback(
    () =>
      queryClient.fetchQuery({
        queryKey: ['drives', 'my'],
        queryFn: () => apiRequest<{ folder: { id: string; name: string } }>('/api/drives/my'),
        staleTime: 60_000,
      }),
    [queryClient],
  );
}

export interface Uploader {
  items: UploadItem[];
  /** Queues files for a folder. Returns the client ids it created. */
  enqueue: (files: File[], options: EnqueueOptions) => string[];
  cancel: (id: string) => void;
  retry: (id: string) => void;
  /** Drops finished, failed and cancelled rows from the tray. */
  clearFinished: () => void;
  activeCount: number;
}

export function useUploader(): Uploader {
  const [items, setItems] = useState<UploadItem[]>([]);

  /** Authoritative queue. `items` is the render mirror. */
  const store = useRef(new Map<string, UploadItem>());
  const order = useRef<string[]>([]);

  // The File objects never enter React state: they are large, and holding them there
  // would keep every uploaded file alive for the lifetime of the page.
  const blobs = useRef(new Map<string, File>());
  const controllers = useRef(new Map<string, AbortController>());
  const running = useRef(new Set<string>());
  const pending = useRef<string[]>([]);
  const queryClient = useQueryClient();
  const mounted = useRef(true);

  const publish = useCallback(() => {
    if (!mounted.current) return;
    setItems(order.current.map((id) => store.current.get(id)).filter((item): item is UploadItem => item !== undefined));
  }, []);

  const patch = useCallback(
    (id: string, changes: Partial<UploadItem>) => {
      const existing = store.current.get(id);
      if (!existing) return;
      store.current.set(id, { ...existing, ...changes });
      publish();
    },
    [publish],
  );

  useEffect(() => {
    mounted.current = true;
    const live = controllers.current;
    return () => {
      mounted.current = false;
      for (const controller of live.values()) controller.abort();
    };
  }, []);

  /** Warns before a reload while bytes are still in flight. */
  useEffect(() => {
    if (!items.some((item) => IN_FLIGHT.includes(item.status))) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      return '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [items]);

  /**
   * Refreshes the drive once the last upload settles.
   *
   * Batched deliberately: one refetch per burst rather than one per file, so dropping
   * fifty files on a folder does not fire fifty list queries.
   */
  useEffect(() => {
    const anyDone = items.some((item) => item.status === 'done');
    const stillGoing = items.some((item) => IN_FLIGHT.includes(item.status));
    if (!anyDone || stillGoing) return;

    void queryClient.invalidateQueries({ queryKey: ['folder'] });
    void queryClient.invalidateQueries({ queryKey: ['recent'] });
    void queryClient.invalidateQueries({ queryKey: ['session'] });
    void queryClient.invalidateQueries({ queryKey: ['drives'] });
  }, [items, queryClient]);

  const runOne = useCallback(
    async (id: string) => {
      const item = store.current.get(id);
      const file = blobs.current.get(id);
      if (!item) return;
      if (!file) {
        patch(id, { status: 'failed', error: 'The selected file is no longer available' });
        return;
      }

      const controller = new AbortController();
      controllers.current.set(id, controller);

      try {
        let ticket: UploadTicket;
        let alreadyHave: number[] = [];

        if (item.sessionId) {
          // A retry resumes the existing session rather than asking for a new one —
          // the whole point of chunking a large file.
          const status = await apiRequest<SessionStatus>(`/api/uploads/${item.sessionId}`, {
            signal: controller.signal,
          });
          ticket = {
            sessionId: status.sessionId,
            chunkSize: status.chunkSize,
            totalChunks: status.totalChunks,
          };
          alreadyHave = status.receivedChunks;
        } else {
          patch(id, { status: 'authorizing', progress: 0 });
          ticket = await apiRequest<UploadTicket>('/api/uploads', {
            method: 'POST',
            body: {
              folderId: item.folderId,
              filename: file.name,
              size: file.size,
              mimeType: file.type || undefined,
              chunked: file.size > CHUNKED_THRESHOLD_BYTES,
              ...(item.targetFileId ? { targetFileId: item.targetFileId } : {}),
              ...(item.versionNote ? { versionNote: item.versionNote } : {}),
            },
            signal: controller.signal,
          });
          patch(id, { sessionId: ticket.sessionId });
        }

        patch(id, { status: 'uploading' });

        if (ticket.chunkSize > 0 && ticket.totalChunks > 0) {
          const received = new Set(alreadyHave);
          let sent = Math.min(received.size * ticket.chunkSize, file.size);

          for (let index = 0; index < ticket.totalChunks; index += 1) {
            if (received.has(index)) continue;

            const start = index * ticket.chunkSize;
            const slice = file.slice(start, Math.min(start + ticket.chunkSize, file.size));
            const base = sent;

            await putWithProgress(`/api/uploads/${ticket.sessionId}/chunks/${index}`, slice, {
              signal: controller.signal,
              onProgress: (loaded) =>
                patch(id, {
                  progress: Math.min(99, Math.round(((base + loaded) / file.size) * 100)),
                }),
            });

            sent += slice.size;
            patch(id, { progress: Math.min(99, Math.round((sent / file.size) * 100)) });
          }
        } else {
          await putWithProgress(`/api/uploads/${ticket.sessionId}/content`, file, {
            signal: controller.signal,
            contentType: file.type || 'application/octet-stream',
            onProgress: (loaded) =>
              patch(id, { progress: Math.min(99, Math.round((loaded / file.size) * 100)) }),
          });
        }

        patch(id, { status: 'finalizing', progress: 99 });
        const result = await apiRequest<{ fileId: string }>(
          `/api/uploads/${ticket.sessionId}/finalize`,
          { method: 'POST' },
        );

        patch(id, { status: 'done', progress: 100, fileId: result.fileId });
        blobs.current.delete(id);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          patch(id, { status: 'cancelled' });
        } else {
          patch(id, {
            status: 'failed',
            error: error instanceof ApiError ? error.message : 'Upload failed',
          });
        }
      } finally {
        controllers.current.delete(id);
        running.current.delete(id);
      }
    },
    [patch],
  );

  /** Starts as many queued uploads as the concurrency limit allows. */
  const pump = useCallback(() => {
    while (running.current.size < MAX_CONCURRENT && pending.current.length > 0) {
      const id = pending.current.shift();
      if (!id) break;
      const item = store.current.get(id);
      if (!item || item.status === 'cancelled') continue;

      running.current.add(id);
      void runOne(id).finally(() => {
        // Re-entering after each completion keeps the window full without a timer.
        if (mounted.current) pump();
      });
    }
  }, [runOne]);

  const enqueue = useCallback(
    (files: File[], options: EnqueueOptions) => {
      const ids: string[] = [];

      for (const file of files) {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        blobs.current.set(id, file);
        store.current.set(id, {
          id,
          name: file.name,
          size: file.size,
          folderId: options.folderId,
          status: 'queued',
          progress: 0,
          ...(options.targetFileId ? { targetFileId: options.targetFileId } : {}),
          ...(options.versionNote ? { versionNote: options.versionNote } : {}),
        });
        order.current.push(id);
        pending.current.push(id);
        ids.push(id);
      }

      publish();
      pump();
      return ids;
    },
    [publish, pump],
  );

  const cancel = useCallback(
    (id: string) => {
      const item = store.current.get(id);
      if (!item || item.status === 'done') return;

      controllers.current.get(id)?.abort();
      pending.current = pending.current.filter((queued) => queued !== id);

      // Tell the server to drop the bytes it already accepted: a cancelled upload must
      // not leave a quarantined file waiting for the expiry sweeper.
      if (item.sessionId) {
        void apiRequest(`/api/uploads/${item.sessionId}`, { method: 'DELETE' }).catch(
          () => undefined,
        );
      }

      blobs.current.delete(id);
      patch(id, { status: 'cancelled' });
    },
    [patch],
  );

  const retry = useCallback(
    (id: string) => {
      if (!blobs.current.has(id)) return;
      patch(id, { status: 'queued', error: undefined, progress: 0 });
      pending.current.push(id);
      pump();
    },
    [patch, pump],
  );

  const clearFinished = useCallback(() => {
    for (const id of [...order.current]) {
      const item = store.current.get(id);
      if (!item || !SETTLED.includes(item.status)) continue;
      store.current.delete(id);
      blobs.current.delete(id);
      order.current = order.current.filter((candidate) => candidate !== id);
    }
    publish();
  }, [publish]);

  return {
    items,
    enqueue,
    cancel,
    retry,
    clearFinished,
    activeCount: items.filter((item) => IN_FLIGHT.includes(item.status)).length,
  };
}
