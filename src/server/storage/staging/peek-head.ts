/**
 * Reading the first bytes of a stream without consuming it.
 *
 * The signature check used to run *after* the whole body had been written to disk: the bytes
 * were streamed to quarantine, then 4 KB were read back off disk and compared against the magic
 * number for the declared extension. That works when staging is a local disk and the cost of a
 * wrong answer is a file to delete.
 *
 * It is the wrong order when staging is a network transfer to Google Drive. A .exe renamed to
 * .csv would be uploaded in full, verified, and only then rejected — a round trip of the entire
 * file for a decision that four kilobytes could have made. Buffering the head first makes the
 * check strictly stronger: the body is never uploaded at all.
 *
 * ── Why not `for await … break` ─────────────────────────────────────────────────────────
 *
 * Breaking out of a `for await` over a Node Readable calls the iterator's `return()`, which
 * **destroys the stream**. The remaining bytes are gone, and the upload silently truncates to
 * whatever the first chunks happened to contain. This reads with `read()` and puts the bytes
 * back with `unshift()` instead, so the caller streams from byte zero.
 */
import { Readable } from 'stream';

export interface PeekedStream {
  /** At most `bytes` from the front. Shorter only when the source is shorter. */
  head: Buffer;
  /**
   * The complete source, from byte zero.
   *
   * Sometimes the original stream with its head pushed back, sometimes a fresh stream over the
   * buffered bytes when the source ended inside the head. Callers must use this and never the
   * stream they passed in.
   */
  body: Readable;
}

export async function peekHead(source: Readable, bytes: number): Promise<PeekedStream> {
  if (bytes <= 0) return { head: Buffer.alloc(0), body: source };

  const chunks: Buffer[] = [];
  let buffered = 0;
  let ended = false;

  while (buffered < bytes) {
    const chunk = source.read() as Buffer | string | null;

    if (chunk === null) {
      if (source.readableEnded) {
        ended = true;
        break;
      }
      const more = await waitForData(source);
      if (!more) {
        ended = true;
        break;
      }
      continue;
    }

    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buffer);
    buffered += buffer.length;
  }

  const collected = Buffer.concat(chunks, buffered);
  const head = collected.subarray(0, Math.min(bytes, collected.length));

  // A source that ended inside the head is now fully in memory, and `unshift` after `end` is
  // an error — so the buffer *is* the body.
  if (ended) return { head, body: Readable.from(collected.length > 0 ? [collected] : []) };

  if (collected.length > 0) source.unshift(collected);
  return { head, body: source };
}

/** Resolves true when more data is available, false when the stream ended first. */
function waitForData(source: Readable): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const cleanup = (): void => {
      source.off('readable', onReadable);
      source.off('end', onEnd);
      source.off('error', onError);
    };
    const onReadable = (): void => {
      cleanup();
      resolve(true);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(false);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    source.once('readable', onReadable);
    source.once('end', onEnd);
    source.once('error', onError);
  });
}
