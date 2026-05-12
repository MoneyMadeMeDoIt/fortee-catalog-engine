/**
 * Google Drive upload utility.
 * Uploads image buffers to a folder structure: root / supplier / styleId / filename
 * Returns a public viewable URL for use in Google Sheets.
 */
import { google, drive_v3 } from 'googleapis';
import { Readable } from 'stream';
import { logger } from '../lib/logger.js';

const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
];

/**
 * Create an authenticated Google Drive API client.
 * Uses the same service account credentials as Sheets.
 */
export function createDriveClient(): drive_v3.Drive {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!email) {
    throw new Error(
      'Missing GOOGLE_SERVICE_ACCOUNT_EMAIL in environment. ' +
      'Set it in .env to your GCP service account email address.'
    );
  }

  if (!rawKey) {
    throw new Error(
      'Missing GOOGLE_PRIVATE_KEY in environment. ' +
      'Set it in .env to the private_key field from your GCP service account JSON key file.'
    );
  }

  const privateKey = rawKey.replace(/\\n/g, '\n');

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: email,
      private_key: privateKey,
    },
    scopes: DRIVE_SCOPES,
  });

  return google.drive({ version: 'v3', auth });
}

const ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_IMAGES_FOLDER_ID ?? '1xIjATpaEdqJYHRiuy0Iy6wIYUcNCXC8k';

/**
 * Find or create a subfolder by name inside a parent folder.
 */
async function findOrCreateFolder(
  drive: drive_v3.Drive,
  parentId: string,
  name: string,
): Promise<string> {
  const query = `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const existing = await drive.files.list({
    q: query,
    fields: 'files(id, name)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (existing.data.files && existing.data.files.length > 0) {
    return existing.data.files[0].id!;
  }

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
    supportsAllDrives: true,
  });

  return created.data.id!;
}

/**
 * Upload a PNG image buffer to Google Drive.
 * Folder structure: root / supplierCode / styleId / filename
 *
 * If a file with the same name already exists in the target folder,
 * it is updated in-place (same URL preserved).
 *
 * Returns a direct-view URL: https://drive.google.com/uc?id=FILE_ID
 */
export async function uploadToDrive(
  drive: drive_v3.Drive,
  buffer: Buffer,
  filename: string,
  supplierCode: string,
  styleId: string,
): Promise<string> {
  const supplierFolderId = await findOrCreateFolder(drive, ROOT_FOLDER_ID, supplierCode);
  const productFolderId = await findOrCreateFolder(drive, supplierFolderId, styleId);

  // Check if file already exists (update in place to preserve URL)
  const query = `'${productFolderId}' in parents and name = '${filename.replace(/'/g, "\\'")}' and trashed = false`;
  const existing = await drive.files.list({
    q: query,
    fields: 'files(id)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  let fileId: string;

  if (existing.data.files && existing.data.files.length > 0) {
    fileId = existing.data.files[0].id!;
    await drive.files.update({
      fileId,
      media: {
        mimeType: 'image/png',
        body: Readable.from(buffer),
      },
      supportsAllDrives: true,
    });
    logger.info(`[drive] Updated existing file ${filename} (${fileId})`);
  } else {
    const created = await drive.files.create({
      requestBody: {
        name: filename,
        parents: [productFolderId],
      },
      media: {
        mimeType: 'image/png',
        body: Readable.from(buffer),
      },
      fields: 'id',
      supportsAllDrives: true,
    });
    fileId = created.data.id!;

    // Make file publicly viewable so the URL works in sheets
    await drive.permissions.create({
      fileId,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
      supportsAllDrives: true,
    });
    logger.info(`[drive] Uploaded new file ${filename} (${fileId})`);
  }

  return `https://drive.google.com/uc?id=${fileId}`;
}

// ---------------------------------------------------------------------------
// Phase 16 Plan 01: Drive helpers consumed by audit + fix scripts.
//
// Appended (not modifying existing exports). Each helper takes a drive_v3.Drive
// as its first arg to stay consistent with createDriveClient + uploadToDrive
// (DI-friendly, no module-global Drive instance).
// ---------------------------------------------------------------------------

/**
 * Drive file metadata returned by `getDriveFileMetadata`.
 *
 * `size` is returned as a string per the Drive v3 API contract (it can exceed
 * Number.MAX_SAFE_INTEGER for very large files). Callers that need a number
 * should parse intentionally (`parseInt(size, 10)`).
 */
export interface DriveFileMetadata {
  mimeType: string;
  size: string;
  name: string;
}

/**
 * Extract a Drive fileId from a public-view URL. Supports both shapes:
 *   - https://drive.google.com/uc?id=<id>
 *   - https://drive.google.com/file/d/<id>/view
 *
 * Returns null for empty input or any URL that doesn't match a Drive shape.
 * Verbatim relocate of the regex from scripts/fetch-fixture-binaries.ts:42-49,
 * with two new callers in Phase 16 (audit + fix orchestrators).
 */
export function extractFileId(url: string): string | null {
  if (!url) return null;
  const ucMatch = url.match(/[?&]id=([\w-]{20,})/);
  if (ucMatch) return ucMatch[1];
  const fileMatch = url.match(/\/file\/d\/([\w-]{20,})/);
  if (fileMatch) return fileMatch[1];
  return null;
}

/**
 * Download a Drive file's binary content by fileId. Returns the file as a
 * Buffer. Used by the Phase 16 verifier to compare BR images against supplier
 * canonical URLs (and by the manual CLI to download a candidate image for the
 * verifier-after-fix check).
 *
 * Throws on Drive API errors (404, permission denied, etc.); callers should
 * try/catch at the per-pid boundary.
 */
export async function downloadFromDrive(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<Buffer> {
  const response = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' },
  );
  return Buffer.from(response.data as ArrayBuffer);
}

/**
 * Soft-delete a Drive file by moving it to trash. Idempotent — repeated calls
 * on an already-trashed file succeed silently.
 *
 * CRITICAL (per user memory `feedback_drive_update_in_place`): when fixing a
 * polluted image, `uploadToDrive` returns the SAME fileId if the filename
 * already exists in the target folder. The caller MUST compare origFileId vs
 * newFileId BEFORE invoking trashDriveFile — otherwise the fix flow destroys
 * its own output. See `scripts/fix-image-pollution.ts` (Plan 03) for the
 * compare-before-trash pattern.
 */
export async function trashDriveFile(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<void> {
  await drive.files.update({
    fileId,
    requestBody: { trashed: true },
    supportsAllDrives: true,
  });
  logger.info(`[drive] Trashed file ${fileId}`);
}

/**
 * Fetch metadata (mimeType, size, name) for a Drive file. Used by Phase 16
 * Pass 1 to detect invalid_image_format pollution (mimeType not in image/*)
 * and by the manual CLI to display per-file context to the operator.
 *
 * Returns empty-string defaults for any field the Drive API omits (so callers
 * don't have to null-check). The size field stays a string per Drive's v3
 * contract.
 */
export async function getDriveFileMetadata(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<DriveFileMetadata> {
  const resp = await drive.files.get({
    fileId,
    fields: 'mimeType,size,name',
    supportsAllDrives: true,
  });
  return {
    mimeType: resp.data.mimeType ?? '',
    size: resp.data.size ?? '0',
    name: resp.data.name ?? '',
  };
}
