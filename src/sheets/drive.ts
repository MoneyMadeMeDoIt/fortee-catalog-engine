/**
 * Google Drive upload utility.
 * Uploads image buffers to a folder structure: root / supplier / styleId / filename
 * Returns a public viewable URL for use in Google Sheets.
 */
import { google, drive_v3 } from 'googleapis';
import { Readable } from 'stream';
import { logger } from '../lib/logger.js';

const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
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
    });
    fileId = created.data.id!;

    // Make file publicly viewable so the URL works in sheets
    await drive.permissions.create({
      fileId,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
    });
    logger.info(`[drive] Uploaded new file ${filename} (${fileId})`);
  }

  return `https://drive.google.com/uc?id=${fileId}`;
}
