/**
 * Web-stream → Node-stream adapter.
 *
 * Lives in the http layer because it is the one place the framework's request shape
 * meets the framework-free server core: `saveFile` takes a Node readable and knows
 * nothing about Next.js.
 *
 * Deliberately a stream, not a buffer. `await request.arrayBuffer()` on a 2 GB upload
 * would put 2 GB in the heap — the failure mode the brief calls out by name.
 */
import { Readable } from 'stream';
import type { NextRequest } from 'next/server';
import { ValidationError } from '@/server/errors/app-error';

export function nodeStreamFromRequest(request: NextRequest): Readable {
  const body = request.body;
  if (!body) throw new ValidationError('The request has no body');
  // `Readable.fromWeb` types the argument as the Node ReadableStream; the runtime
  // accepts the DOM stream Next provides.
  return Readable.fromWeb(body as unknown as Parameters<typeof Readable.fromWeb>[0]);
}

/**
 * Reads a bounded request body into memory. Only for chunks, whose size is agreed in
 * advance — never for a whole file.
 */
export async function readBoundedBody(request: NextRequest, maxBytes: number): Promise<Buffer> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    throw new ValidationError(`Chunk exceeds the agreed maximum of ${maxBytes} bytes`);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const piece of nodeStreamFromRequest(request)) {
    const buffer = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as ArrayBufferView as Uint8Array);
    total += buffer.byteLength;
    if (total > maxBytes) {
      throw new ValidationError(`Chunk exceeds the agreed maximum of ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
