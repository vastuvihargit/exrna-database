/**
 * The Shared Drive connection check.
 *
 * Its job is to catch the configuration mistakes people actually make on the first attempt,
 * and to catch them *before* research data goes anywhere. Two are worth naming:
 *
 *   • The key is valid and the API answers, but nobody added the service account as a
 *     member of the Shared Drive. This is invisible from the Google Cloud console and is by
 *     far the most common first-time failure.
 *   • A folder id pasted from the wrong place. A root folder that lives in a different
 *     drive — or in somebody's personal My Drive — produces a deployment that looks
 *     perfectly healthy and quietly writes the company's research into a personal account.
 *     That is the exact arrangement this whole design exists to prevent, so it is a
 *     connection *failure*, not a warning.
 */
import { describe, expect, it } from 'vitest';

import { checkDriveConnectionWith } from '@/server/storage/google/drive-health';
import { DriveApiError, GOOGLE_FOLDER_MIME, type DriveClient, type DriveFileResource } from '@/server/storage/google';

import { FakeDriveClient } from '../helpers/fake-drive';

const DRIVE_ID = 'drive-company';

/** Overrides one method of the fake, for the states it cannot naturally reach. */
function withOverrides(drive: FakeDriveClient, overrides: Partial<DriveClient>): DriveClient {
  return new Proxy(drive, {
    get(target, property, receiver) {
      if (property in overrides) return (overrides as Record<string | symbol, unknown>)[property];
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as DriveClient;
}

describe('Shared Drive connection check', () => {
  it('reports a healthy connection when no root folder is configured', async () => {
    const drive = new FakeDriveClient({ driveId: DRIVE_ID, driveName: 'Company Research' });

    const health = await checkDriveConnectionWith(drive, DRIVE_ID, null);

    expect(health.connected).toBe(true);
    expect(health.driveName).toBe('Company Research');
    expect(health.rootFolderOk).toBeNull();
    expect(health.error).toBeNull();
  });

  it('reports a healthy connection with a valid root folder inside the drive', async () => {
    const drive = new FakeDriveClient({ driveId: DRIVE_ID });
    const root = drive.seedFolder({ name: 'Research', parentId: DRIVE_ID });

    const health = await checkDriveConnectionWith(drive, DRIVE_ID, root.id);

    expect(health.connected).toBe(true);
    expect(health.rootFolderOk).toBe(true);
  });

  /**
   * The most common first-time failure, and the message says what to do about it rather
   * than repeating Google's "File not found".
   */
  it('points at Shared Drive membership when the drive cannot be opened', async () => {
    const drive = new FakeDriveClient({ driveId: DRIVE_ID });

    const health = await checkDriveConnectionWith(drive, 'some-other-drive', null);

    expect(health.connected).toBe(false);
    expect(health.error).toMatch(/member of the Shared Drive/i);
  });

  /** Seeing a drive is not the same as being able to write to it. */
  it('refuses a drive the service account can see but not add content to', async () => {
    const drive = new FakeDriveClient({ driveId: DRIVE_ID, canAddChildren: false });

    const health = await checkDriveConnectionWith(drive, DRIVE_ID, null);

    expect(health.connected).toBe(false);
    expect(health.canAddContent).toBe(false);
    expect(health.error).toMatch(/Content Manager/i);
  });

  it('refuses a root folder that belongs to a different drive', async () => {
    const drive = new FakeDriveClient({ driveId: DRIVE_ID });
    const foreign: DriveFileResource = {
      id: 'foreign-folder',
      name: 'Research',
      mimeType: GOOGLE_FOLDER_MIME,
      driveId: 'drive-somewhere-else',
    };

    const health = await checkDriveConnectionWith(
      withOverrides(drive, { getFile: async () => foreign }),
      DRIVE_ID,
      'foreign-folder',
    );

    expect(health.connected).toBe(false);
    expect(health.rootFolderOk).toBe(false);
    expect(health.error).toMatch(/different drive/i);
  });

  /**
   * No `driveId` at all means the item is not in a Shared Drive — i.e. it is in some
   * individual's My Drive. Files there are owned by that person and vanish with their
   * account.
   */
  it('refuses a root folder that is not in a Shared Drive at all', async () => {
    const drive = new FakeDriveClient({ driveId: DRIVE_ID });
    const personal: DriveFileResource = { id: 'personal', name: 'Research', mimeType: GOOGLE_FOLDER_MIME };

    const health = await checkDriveConnectionWith(
      withOverrides(drive, { getFile: async () => personal }),
      DRIVE_ID,
      'personal',
    );

    expect(health.connected).toBe(false);
    expect(health.error).toMatch(/individual account/i);
  });

  it('refuses a root that is a file rather than a folder', async () => {
    const drive = new FakeDriveClient({ driveId: DRIVE_ID });
    const file = drive.seedFile({ name: 'notes.txt', parentId: DRIVE_ID, content: Buffer.from('x') });

    const health = await checkDriveConnectionWith(drive, DRIVE_ID, file.id);

    expect(health.connected).toBe(false);
    expect(health.error).toMatch(/not a folder/i);
  });

  it('refuses a root folder that has been trashed', async () => {
    const drive = new FakeDriveClient({ driveId: DRIVE_ID });
    const root = drive.seedFolder({ name: 'Research', parentId: DRIVE_ID });
    await drive.updateFile(root.id, { trashed: true });

    const health = await checkDriveConnectionWith(drive, DRIVE_ID, root.id);

    expect(health.connected).toBe(false);
    expect(health.error).toMatch(/trash/i);
  });

  it('translates an access-denied response into an actionable message', async () => {
    const drive = new FakeDriveClient({ driveId: DRIVE_ID });

    const health = await checkDriveConnectionWith(
      withOverrides(drive, {
        getDrive: async () => {
          throw new DriveApiError({ status: 403, reason: 'insufficientPermissions', message: 'Insufficient' });
        },
      }),
      DRIVE_ID,
      null,
    );

    expect(health.connected).toBe(false);
    expect(health.error).toMatch(/not a member of this drive/i);
  });

  /** Metadata calls only. A probe object on every readiness poll would pollute Drive activity. */
  it('writes nothing to the drive', async () => {
    const drive = new FakeDriveClient({ driveId: DRIVE_ID });
    const root = drive.seedFolder({ name: 'Research', parentId: DRIVE_ID });

    await checkDriveConnectionWith(drive, DRIVE_ID, root.id);

    expect(drive.calls).not.toContain('uploadFile');
    expect(drive.calls).not.toContain('createFolder');
    expect(drive.calls).not.toContain('deleteFile');
    expect(drive.calls).not.toContain('updateFile');
  });
});
