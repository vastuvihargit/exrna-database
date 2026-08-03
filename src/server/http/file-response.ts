/**
 * Turns a storage read into an HTTP response.
 *
 * Lives beside `api-response.ts` for the same reason: this is the Next.js boundary, and
 * the only place allowed to know that a route's answer is a `Response`.
 *
 * The headers here are load-bearing, not decoration:
 *
 * - `nosniff` stops the browser second-guessing the content type. Without it, a stored
 *   file served as `application/octet-stream` can still be sniffed into HTML and executed.
 * - The sandbox CSP applies to inline previews, so even a document that lied its way past
 *   upload validation cannot run script, load a remote resource, or frame anything in
 *   this origin.
 * - `private, no-store` keeps research data out of shared caches; the reverse proxy sits
 *   in front of every one of these responses.
 */
import { Readable } from 'stream';
import { NextResponse } from 'next/server';

import type { FileStream } from '@/server/services/download.service';

export interface StreamOptions {
  /** Apply the inline-preview sandbox. Always true for preview, never for download. */
  sandbox?: boolean;
}

/**
 * Content-Security-Policy for inline previews.
 *
 * `sandbox` with no allow-tokens is the strongest form: no scripts, no forms, no
 * same-origin privileges. `default-src 'none'` then blocks every outbound fetch, so a
 * crafted SVG or XML file cannot call home.
 */
const PREVIEW_CSP = [
  "default-src 'none'",
  "img-src 'self' data:",
  "media-src 'self'",
  "style-src 'unsafe-inline'",
  'sandbox',
  "frame-ancestors 'self'",
].join('; ');

export function streamFile(
  stream: FileStream,
  method: string,
  options: StreamOptions = {},
): Response {
  const headers = new Headers({
    'Content-Type': stream.contentType,
    'Content-Disposition': stream.contentDisposition,
    // Stored versions are immutable, so the checksum is a perfect validator.
    ETag: stream.etag,
    // A Google-native document is converted on the way out, so there is no stored object to
    // take a byte range of. Saying `none` is what stops a client asking for one and being
    // handed the whole body with a 206.
    'Accept-Ranges': stream.acceptRanges === false ? 'none' : 'bytes',
    'Cache-Control': 'private, no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    // Belt and braces with the CSP: no referrer leaves with a preview request.
    'Referrer-Policy': 'no-referrer',
  });

  /**
   * Omitted, not zeroed, when the length is genuinely unknown — an export is generated on
   * demand and its size is not known until it has been produced. `Content-Length: 0` would
   * make the browser stop reading immediately and save an empty file; leaving the header
   * off falls back to chunked transfer, which is correct.
   */
  if (stream.contentLength !== null) {
    headers.set('Content-Length', String(stream.contentLength));
  }

  if (options.sandbox) {
    headers.set('Content-Security-Policy', PREVIEW_CSP);
  }

  if (stream.range) {
    headers.set(
      'Content-Range',
      `bytes ${stream.range.start}-${stream.range.end}/${stream.totalSize}`,
    );
  }

  // HEAD must carry the same headers and no body — that is the whole point of it.
  if (method === 'HEAD') {
    destroy(stream.body);
    return new NextResponse(null, { status: stream.range ? 206 : 200, headers });
  }

  return new NextResponse(toWebStream(stream.body), {
    status: stream.range ? 206 : 200,
    headers,
  });
}

/**
 * Adapts a Node readable to a web ReadableStream.
 *
 * `Readable.toWeb` exists but types the result as a stream of `any`; wrapping it keeps the
 * cast in one place instead of at every call site.
 */
function toWebStream(body: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return Readable.toWeb(body as Readable) as ReadableStream<Uint8Array>;
}

/**
 * Releases a stream we opened but will not read.
 *
 * Skipping this leaks a file descriptor per HEAD request, which is the kind of thing that
 * only shows up as an exhausted server weeks later.
 */
function destroy(body: NodeJS.ReadableStream): void {
  if (typeof (body as Readable).destroy === 'function') (body as Readable).destroy();
}
