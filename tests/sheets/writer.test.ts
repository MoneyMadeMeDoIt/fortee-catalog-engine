import { describe, it, expect, vi } from 'vitest';
import { writeUpdates } from '../../src/sheets/writer.js';
import type { EnrichmentUpdate } from '../../src/sheets/types.js';

function createMockSheets(totalUpdatedCells = 3) {
  const batchUpdate = vi.fn().mockResolvedValue({
    data: { totalUpdatedCells },
  });

  return {
    client: {
      spreadsheets: {
        values: { batchUpdate },
      },
    } as any,
    batchUpdate,
  };
}

describe('writeUpdates', () => {
  it('returns 0 and makes no API call when updates array is empty', async () => {
    const { client, batchUpdate } = createMockSheets();
    const result = await writeUpdates(client, 'sheet-id', []);
    expect(result).toBe(0);
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('calls batchUpdate once with RAW mode and all updates', async () => {
    const { client, batchUpdate } = createMockSheets(3);
    const updates: EnrichmentUpdate[] = [
      { range: 'Sheet1!A2', values: [['val1']] },
      { range: 'Sheet1!B2', values: [['val2']] },
      { range: 'Sheet1!C2', values: [['val3']] },
    ];
    await writeUpdates(client, 'sheet-id', updates);
    expect(batchUpdate).toHaveBeenCalledTimes(1);
    expect(batchUpdate).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-id',
      requestBody: {
        valueInputOption: 'RAW',
        data: updates,
      },
    });
  });

  it('returns totalUpdatedCells from API response', async () => {
    const { client } = createMockSheets(7);
    const updates: EnrichmentUpdate[] = [
      { range: 'Sheet1!A2', values: [['val1']] },
    ];
    const result = await writeUpdates(client, 'sheet-id', updates);
    expect(result).toBe(7);
  });
});
