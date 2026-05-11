import { createSheetsClient } from '../src/sheets/client.js';
const sheets = createSheetsClient();
const r = await sheets.spreadsheets.values.get({
  spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID!,
  range: (process.env.GOOGLE_SHEET_NAME || 'Bestsellers-Ready') + '!1:1',
});
console.log(JSON.stringify(r.data.values?.[0], null, 2));
