/**
 * One-shot helper: trash a single Drive file by its fileId.
 *
 * Usage:
 *   NODE_OPTIONS=--use-system-ca npx tsx scripts/trash-one-file.ts <fileId>
 */
import 'dotenv/config';
import { createDriveClient, trashDriveFile } from '../src/sheets/drive.js';

async function main() {
  const fileId = process.argv[2];
  if (!fileId) {
    console.error('Usage: tsx scripts/trash-one-file.ts <fileId>');
    process.exit(1);
  }
  const drive = createDriveClient();
  await trashDriveFile(drive, fileId);
  console.log(`Trashed ${fileId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
