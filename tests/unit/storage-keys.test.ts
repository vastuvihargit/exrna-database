import { describe, expect, it } from 'vitest';
import {
  buildOriginalKey,
  buildVersionKey,
  buildPreviewKey,
  buildQuarantineKey,
  buildTemporaryChunkKey,
  buildMigrationStagingKey,
  buildExportKey,
  buildArchiveKey,
  newStorageId,
} from '@/server/storage/keys';
import { assertSafeKey } from '@/server/storage/path-safety';

const ORG = '652f1a2b3c4d5e6f70819200';
const DEPT = '652f1a2b3c4d5e6f70819201';
const FILE = '652f1a2b3c4d5e6f70819202';
const VERSION = '652f1a2b3c4d5e6f70819203';

describe('storage key builders', () => {
  it('builds the documented originals layout', () => {
    const { key, area } = buildOriginalKey({ organizationId: ORG, departmentId: DEPT, fileId: FILE, versionId: VERSION });
    expect(area).toBe('originals');
    expect(key).toBe(`${ORG}/${DEPT}/${FILE}/${VERSION}`);
  });

  it('substitutes a placeholder when a file has no department', () => {
    const { key } = buildOriginalKey({ organizationId: ORG, departmentId: null, fileId: FILE, versionId: VERSION });
    expect(key).toBe(`${ORG}/no-department/${FILE}/${VERSION}`);
  });

  it('produces keys that always pass the safety check', () => {
    const keys = [
      buildOriginalKey({ organizationId: ORG, departmentId: DEPT, fileId: FILE, versionId: VERSION }),
      buildVersionKey({ fileId: FILE, versionId: VERSION }),
      buildPreviewKey({ fileId: FILE, versionId: VERSION, extension: 'pdf' }),
      buildQuarantineKey({ uploadSessionId: FILE }),
      buildQuarantineKey({ uploadSessionId: FILE, part: 'assembled' }),
      buildTemporaryChunkKey({ uploadSessionId: FILE, chunkIndex: 42 }),
      buildMigrationStagingKey({ migrationJobId: FILE, migrationItemId: VERSION }),
      buildExportKey({ userId: FILE, exportJobId: VERSION }),
      buildArchiveKey({ organizationId: ORG, year: 2026, fileId: FILE, versionId: VERSION }),
    ];
    for (const { key } of keys) {
      expect(() => assertSafeKey(key)).not.toThrow();
    }
  });

  it('pads chunk indexes so lexical order matches numeric order', () => {
    expect(buildTemporaryChunkKey({ uploadSessionId: FILE, chunkIndex: 0 }).key).toBe(`${FILE}/part-000000`);
    expect(buildTemporaryChunkKey({ uploadSessionId: FILE, chunkIndex: 7 }).key).toBe(`${FILE}/part-000007`);
    expect(buildTemporaryChunkKey({ uploadSessionId: FILE, chunkIndex: 123456 }).key).toBe(`${FILE}/part-123456`);
  });

  // Identifiers come from the database, but the builders refuse anything that could
  // introduce a separator — so a compromised caller still cannot craft a path.
  it('rejects identifiers containing path characters', () => {
    expect(() => buildOriginalKey({ organizationId: '../..', departmentId: DEPT, fileId: FILE, versionId: VERSION })).toThrow();
    expect(() => buildVersionKey({ fileId: 'a/b', versionId: VERSION })).toThrow();
    expect(() => buildVersionKey({ fileId: FILE, versionId: '../escape' })).toThrow();
    expect(() => buildExportKey({ userId: '..', exportJobId: VERSION })).toThrow();
  });

  it('rejects invalid chunk indexes and archive years', () => {
    expect(() => buildTemporaryChunkKey({ uploadSessionId: FILE, chunkIndex: -1 })).toThrow();
    expect(() => buildTemporaryChunkKey({ uploadSessionId: FILE, chunkIndex: 1.5 })).toThrow();
    expect(() => buildArchiveKey({ organizationId: ORG, year: 12026, fileId: FILE, versionId: VERSION })).toThrow();
  });

  it('sanitises the preview extension rather than trusting it', () => {
    expect(buildPreviewKey({ fileId: FILE, versionId: VERSION, extension: 'PDF' }).key.endsWith('.pdf')).toBe(true);
    // Separators are stripped, so a crafted "extension" cannot introduce a path.
    const crafted = buildPreviewKey({ fileId: FILE, versionId: VERSION, extension: '../x' }).key;
    expect(crafted).toBe(`${FILE}/${VERSION}.x`);
    expect(() => assertSafeKey(crafted)).not.toThrow();
    // An extension that sanitises to nothing is rejected outright.
    expect(() => buildPreviewKey({ fileId: FILE, versionId: VERSION, extension: '../' })).toThrow();
  });

  it('generates unique storage ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newStorageId()));
    expect(ids.size).toBe(500);
  });
});
