/**
 * Google Sheets API client factory.
 * Authenticates via service account credentials from environment variables.
 */
import { google, sheets_v4 } from 'googleapis';

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];

/**
 * Create an authenticated Google Sheets API client.
 * Reads GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY from process.env.
 * Throws a descriptive error if either is missing.
 * Unescapes literal \\n in the private key to actual newlines.
 */
export function createSheetsClient(): sheets_v4.Sheets {
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
    scopes: SCOPES,
  });

  return google.sheets({ version: 'v4', auth });
}
