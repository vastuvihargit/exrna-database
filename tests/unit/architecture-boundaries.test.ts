/**
 * Architectural guard rails.
 *
 * These are assertions about the shape of the codebase, not about runtime behaviour.
 * They exist because two Phase 0 promises are easy to break by accident and expensive
 * to discover late:
 *   1. src/server/** stays framework-free so the backend can move to NestJS.
 *   2. only the storage layer touches the filesystem.
 */
import { describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';

const SRC = path.resolve(process.cwd(), 'src');

async function walk(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.isFile() && /\.tsx?$/.test(entry.name) ? [full] : [];
    }),
  );
  return files.flat();
}

describe('architecture boundaries', () => {
  it('keeps the server core free of Next.js and React imports', async () => {
    const files = (await walk(path.join(SRC, 'server'))).filter(
      // The http/ folder is the declared translation boundary.
      (file) => !file.includes(`${path.sep}http${path.sep}`),
    );

    const offenders: string[] = [];
    for (const file of files) {
      const source = await fsp.readFile(file, 'utf8');
      if (/from ['"](next|next\/[^'"]+|react|react-dom)['"]/.test(source)) {
        offenders.push(path.relative(SRC, file));
      }
    }

    expect(offenders, `Framework imports leaked into the server core: ${offenders.join(', ')}`).toEqual([]);
  });

  it('confines filesystem access to the storage layer', async () => {
    const files = await walk(SRC);
    const allowed = [
      path.join(SRC, 'server', 'storage'),
    ];

    const offenders: string[] = [];
    for (const file of files) {
      if (allowed.some((dir) => file.startsWith(dir))) continue;
      const source = await fsp.readFile(file, 'utf8');
      if (/from ['"](node:)?fs(\/promises)?['"]/.test(source)) {
        offenders.push(path.relative(SRC, file));
      }
    }

    expect(offenders, `Direct fs usage outside the storage layer: ${offenders.join(', ')}`).toEqual([]);
  });

  it('keeps database and storage imports out of UI components', async () => {
    const uiDirs = [path.join(SRC, 'components'), path.join(SRC, 'hooks')];
    const offenders: string[] = [];

    for (const dir of uiDirs) {
      const files = await walk(dir).catch(() => []);
      for (const file of files) {
        const source = await fsp.readFile(file, 'utf8');
        if (/from ['"]@\/server\/(db|repositories|storage|services)[^'"]*['"]/.test(source) || /from ['"]mongoose['"]/.test(source)) {
          offenders.push(path.relative(SRC, file));
        }
      }
    }

    expect(offenders, `UI reached past the API layer: ${offenders.join(', ')}`).toEqual([]);
  });
});
