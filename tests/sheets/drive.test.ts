/**
 * Tests for src/sheets/drive.ts.
 *
 * Coverage areas:
 *   - extractFileId URL parsing (Phase 16 carry-over).
 *   - downloadFromDrive / getDriveFileMetadata / trashDriveFile / uploadToDrive
 *     timeout + retry budget added in Phase 17 Plan 01 (B-1 fix).
 *
 * All Drive API calls are mocked via a hand-rolled drive_v3.Drive shape. No
 * real network requests, no service account.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock: logger — capture warn calls for retry assertions, info for upload logs
// ---------------------------------------------------------------------------

const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();
const mockLoggerDebug = vi.fn();
vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError,
    debug: mockLoggerDebug,
  },
}));

// ---------------------------------------------------------------------------
// Mock: googleapis — prevent real auth client instantiation when drive.ts loads
// ---------------------------------------------------------------------------

vi.mock('googleapis', () => ({
  google: {
    drive: vi.fn(),
    auth: { GoogleAuth: vi.fn() },
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockDrive() {
  const filesGet = vi.fn();
  const filesUpdate = vi.fn();
  const filesCreate = vi.fn();
  const filesList = vi.fn();
  const permissionsCreate = vi.fn();
  const drive = {
    files: {
      get: filesGet,
      update: filesUpdate,
      create: filesCreate,
      list: filesList,
    },
    permissions: { create: permissionsCreate },
  };
  return { drive, filesGet, filesUpdate, filesCreate, filesList, permissionsCreate };
}

/** Build a fake gaxios-style timeout error using `code` (one of several). */
function timeoutErr(
  code: 'ECONNABORTED' | 'ETIMEDOUT' | 'ERR_CANCELED' = 'ECONNABORTED',
  message = 'timeout of 30000ms exceeded',
): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// extractFileId — Phase 16 carry-over
// ---------------------------------------------------------------------------

describe('extractFileId', () => {
  it('returns the fileId from https://drive.google.com/uc?id=...', async () => {
    const { extractFileId } = await import('../../src/sheets/drive.js');
    expect(extractFileId('https://drive.google.com/uc?id=abc123def456ghi789jk')).toBe(
      'abc123def456ghi789jk',
    );
  });

  it('returns the fileId from https://drive.google.com/file/d/<id>/view', async () => {
    const { extractFileId } = await import('../../src/sheets/drive.js');
    expect(extractFileId('https://drive.google.com/file/d/abc123def456ghi789jk/view')).toBe(
      'abc123def456ghi789jk',
    );
  });

  it('returns null for an empty string', async () => {
    const { extractFileId } = await import('../../src/sheets/drive.js');
    expect(extractFileId('')).toBeNull();
  });

  it('returns null for a non-Drive URL', async () => {
    const { extractFileId } = await import('../../src/sheets/drive.js');
    expect(extractFileId('https://example.com/foo')).toBeNull();
  });

  it('returns null when no recognizable fileId pattern present', async () => {
    const { extractFileId } = await import('../../src/sheets/drive.js');
    expect(extractFileId('https://drive.google.com/short')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 1: downloadFromDrive happy path — no retries on first-shot success
// ---------------------------------------------------------------------------

describe('downloadFromDrive — happy path', () => {
  it('returns Buffer on first attempt without warn-logging a retry', async () => {
    const { drive, filesGet } = makeMockDrive();
    const fakeBytes = new Uint8Array([1, 2, 3, 4]).buffer;
    filesGet.mockResolvedValueOnce({ data: fakeBytes });

    const { downloadFromDrive } = await import('../../src/sheets/drive.js');
    const buffer = await downloadFromDrive(drive as never, 'fileId123');

    expect(filesGet).toHaveBeenCalledTimes(1);
    const [params, opts] = filesGet.mock.calls[0];
    expect(params).toEqual({
      fileId: 'fileId123',
      alt: 'media',
      supportsAllDrives: true,
    });
    // The 2nd-arg options object MUST carry both responseType AND timeout.
    expect(opts.responseType).toBe('arraybuffer');
    expect(opts.timeout).toBe(30_000);

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBe(4);
    expect(buffer[0]).toBe(1);
    expect(buffer[3]).toBe(4);

    // No retry warnings on happy path.
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 2: downloadFromDrive timeout + retry — succeeds on 3rd attempt
// ---------------------------------------------------------------------------

describe('downloadFromDrive — timeout retry (succeeds on 3rd attempt)', () => {
  it('retries on timeout (2 retries) then resolves with Buffer', async () => {
    const { drive, filesGet } = makeMockDrive();
    const fakeBytes = new Uint8Array([9, 8, 7]).buffer;
    filesGet
      .mockRejectedValueOnce(timeoutErr('ECONNABORTED'))
      .mockRejectedValueOnce(timeoutErr('ECONNABORTED'))
      .mockResolvedValueOnce({ data: fakeBytes });

    const { downloadFromDrive } = await import('../../src/sheets/drive.js');
    const buffer = await downloadFromDrive(drive as never, 'fileIdRetry');

    expect(filesGet).toHaveBeenCalledTimes(3);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBe(3);

    // One warn per failed attempt (= 2 warns, since the 3rd attempt succeeds).
    expect(mockLoggerWarn).toHaveBeenCalledTimes(2);
    const warnMsgs = mockLoggerWarn.mock.calls.map((c) => String(c[0]));
    expect(warnMsgs[0]).toContain('attempt 1/3');
    expect(warnMsgs[1]).toContain('attempt 2/3');
    expect(warnMsgs[0]).toContain('fileIdRetry');
  });
});

// ---------------------------------------------------------------------------
// Test 3: downloadFromDrive all 3 attempts time out → rethrow gaxios error
// ---------------------------------------------------------------------------

describe('downloadFromDrive — all 3 attempts time out', () => {
  it('rethrows the timeout error after exhausting the retry budget', async () => {
    const { drive, filesGet } = makeMockDrive();
    filesGet.mockRejectedValue(timeoutErr('ETIMEDOUT', 'socket hang up'));

    const { downloadFromDrive } = await import('../../src/sheets/drive.js');
    await expect(downloadFromDrive(drive as never, 'fileIdDead')).rejects.toThrow(
      /socket hang up/,
    );

    expect(filesGet).toHaveBeenCalledTimes(3);
    expect(mockLoggerWarn).toHaveBeenCalledTimes(3);
    const lastWarn = String(mockLoggerWarn.mock.calls[2][0]);
    expect(lastWarn).toContain('attempt 3/3');
  });
});

// ---------------------------------------------------------------------------
// Test 4: downloadFromDrive non-timeout error rethrown immediately (no retry)
// ---------------------------------------------------------------------------

describe('downloadFromDrive — non-timeout error is rethrown immediately', () => {
  it('does NOT retry on 404 / hard errors', async () => {
    const { drive, filesGet } = makeMockDrive();
    const notFound = new Error('File not found') as Error & { code: number };
    notFound.code = 404;
    filesGet.mockRejectedValueOnce(notFound);

    const { downloadFromDrive } = await import('../../src/sheets/drive.js');
    await expect(downloadFromDrive(drive as never, 'fileIdGone')).rejects.toThrow(
      /File not found/,
    );

    // Single attempt, no retry warnings.
    expect(filesGet).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 5: getDriveFileMetadata happy path + timeout retry
// ---------------------------------------------------------------------------

describe('getDriveFileMetadata — happy path and timeout retry', () => {
  it('returns {mimeType,size,name} on first attempt and passes timeout option', async () => {
    const { drive, filesGet } = makeMockDrive();
    filesGet.mockResolvedValueOnce({
      data: { mimeType: 'image/png', size: '12345', name: 'front.png' },
    });

    const { getDriveFileMetadata } = await import('../../src/sheets/drive.js');
    const result = await getDriveFileMetadata(drive as never, 'fileId123');

    expect(filesGet).toHaveBeenCalledTimes(1);
    const [params, opts] = filesGet.mock.calls[0];
    expect(params).toEqual({
      fileId: 'fileId123',
      fields: 'mimeType,size,name',
      supportsAllDrives: true,
    });
    expect(opts).toEqual({ timeout: 30_000 });
    expect(result).toEqual({
      mimeType: 'image/png',
      size: '12345',
      name: 'front.png',
    });
  });

  it('returns empty-string defaults when Drive omits a field', async () => {
    const { drive, filesGet } = makeMockDrive();
    filesGet.mockResolvedValueOnce({ data: { mimeType: 'image/jpeg' } });

    const { getDriveFileMetadata } = await import('../../src/sheets/drive.js');
    const result = await getDriveFileMetadata(drive as never, 'fileIdMissing');

    expect(result.mimeType).toBe('image/jpeg');
    expect(result.size).toBe('0');
    expect(result.name).toBe('');
  });

  it('retries on timeout up to 2 times then resolves', async () => {
    const { drive, filesGet } = makeMockDrive();
    filesGet
      .mockRejectedValueOnce(timeoutErr('ERR_CANCELED'))
      .mockRejectedValueOnce(timeoutErr('ETIMEDOUT'))
      .mockResolvedValueOnce({ data: { mimeType: 'image/png', size: '99', name: 'r.png' } });

    const { getDriveFileMetadata } = await import('../../src/sheets/drive.js');
    const result = await getDriveFileMetadata(drive as never, 'fileMeta');

    expect(filesGet).toHaveBeenCalledTimes(3);
    expect(result.mimeType).toBe('image/png');
    expect(mockLoggerWarn).toHaveBeenCalledTimes(2);
    expect(String(mockLoggerWarn.mock.calls[0][0])).toContain('attempt 1/3');
  });
});

// ---------------------------------------------------------------------------
// Test 6: trashDriveFile timeout retry
// ---------------------------------------------------------------------------

describe('trashDriveFile — timeout retry', () => {
  it('retries 2 times then resolves to void', async () => {
    const { drive, filesUpdate } = makeMockDrive();
    filesUpdate
      .mockRejectedValueOnce(timeoutErr('ETIMEDOUT'))
      .mockRejectedValueOnce(timeoutErr('ETIMEDOUT'))
      .mockResolvedValueOnce({ data: {} });

    const { trashDriveFile } = await import('../../src/sheets/drive.js');
    const result = await trashDriveFile(drive as never, 'fileId123');

    expect(result).toBeUndefined();
    expect(filesUpdate).toHaveBeenCalledTimes(3);
    // Every call passes the timeout option.
    for (const call of filesUpdate.mock.calls) {
      const opts = call[1];
      expect(opts).toEqual({ timeout: 30_000 });
    }
    expect(mockLoggerWarn).toHaveBeenCalledTimes(2);
  });

  it('happy path: invokes files.update with trashed=true and logs info', async () => {
    const { drive, filesUpdate } = makeMockDrive();
    filesUpdate.mockResolvedValueOnce({ data: {} });

    const { trashDriveFile } = await import('../../src/sheets/drive.js');
    await trashDriveFile(drive as never, 'fileId123');

    expect(filesUpdate).toHaveBeenCalledTimes(1);
    expect(filesUpdate.mock.calls[0][0]).toEqual({
      fileId: 'fileId123',
      requestBody: { trashed: true },
      supportsAllDrives: true,
    });
    const firstLogMsg = String(mockLoggerInfo.mock.calls[0][0]);
    expect(firstLogMsg).toContain('[drive]');
    expect(firstLogMsg).toContain('fileId123');
  });
});

// ---------------------------------------------------------------------------
// Test 7: uploadToDrive — timeout retry on internal findOrCreateFolder.files.list
// ---------------------------------------------------------------------------

describe('uploadToDrive — timeout retry on findOrCreateFolder files.list', () => {
  it('retries the list call once, then completes the upload normally', async () => {
    const m = makeMockDrive();
    // 1st findOrCreateFolder (supplier folder) — list throws timeout once, then returns existing folder.
    m.filesList
      .mockRejectedValueOnce(timeoutErr('ERR_CANCELED'))
      .mockResolvedValueOnce({ data: { files: [{ id: 'SUPPLIER_FOLDER', name: 'CSW' }] } })
      // 2nd findOrCreateFolder (style folder) — returns existing folder immediately.
      .mockResolvedValueOnce({ data: { files: [{ id: 'STYLE_FOLDER', name: '5000' }] } })
      // Existence check on filename — no existing file.
      .mockResolvedValueOnce({ data: { files: [] } });

    // No existing file, so files.create + permissions.create are called.
    m.filesCreate.mockResolvedValueOnce({ data: { id: 'NEW_FILE_ID' } });
    m.permissionsCreate.mockResolvedValueOnce({ data: {} });

    const { uploadToDrive } = await import('../../src/sheets/drive.js');
    const url = await uploadToDrive(
      m.drive as never,
      Buffer.from([1, 2, 3]),
      'front.png',
      'CSW',
      '5000',
    );

    expect(url).toBe('https://drive.google.com/uc?id=NEW_FILE_ID');
    expect(m.filesList).toHaveBeenCalledTimes(4); // 1 retry + 3 successful lookups
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(String(mockLoggerWarn.mock.calls[0][0])).toContain('attempt 1/3');
  });
});

// ---------------------------------------------------------------------------
// Test 8: uploadToDrive — timeout retry on files.create
// ---------------------------------------------------------------------------

describe('uploadToDrive — timeout retry on files.create', () => {
  it('retries the create call once, then completes the upload normally', async () => {
    const m = makeMockDrive();
    m.filesList
      .mockResolvedValueOnce({ data: { files: [{ id: 'SUPPLIER_FOLDER' }] } })
      .mockResolvedValueOnce({ data: { files: [{ id: 'STYLE_FOLDER' }] } })
      .mockResolvedValueOnce({ data: { files: [] } });

    const abortedErr = new Error('request aborted') as Error & { code?: string };
    m.filesCreate
      .mockRejectedValueOnce(abortedErr)
      .mockResolvedValueOnce({ data: { id: 'CREATED_AFTER_RETRY' } });
    m.permissionsCreate.mockResolvedValueOnce({ data: {} });

    const { uploadToDrive } = await import('../../src/sheets/drive.js');
    const url = await uploadToDrive(
      m.drive as never,
      Buffer.from([1, 2, 3]),
      'front.png',
      'CSW',
      '5000',
    );

    expect(url).toBe('https://drive.google.com/uc?id=CREATED_AFTER_RETRY');
    expect(m.filesCreate).toHaveBeenCalledTimes(2);
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(String(mockLoggerWarn.mock.calls[0][0])).toContain('attempt 1/3');
  });
});

// ---------------------------------------------------------------------------
// Test 9: T-17-02 credential-leak guard — retry log lines must not contain creds
// ---------------------------------------------------------------------------

describe('T-17-02: retry log lines do NOT contain credentials', () => {
  it('warn messages from a timeout retry never contain Bearer/Authorization/private_key', async () => {
    const { drive, filesGet } = makeMockDrive();
    filesGet.mockRejectedValue(timeoutErr('ECONNABORTED'));

    const { downloadFromDrive } = await import('../../src/sheets/drive.js');
    await expect(downloadFromDrive(drive as never, 'leakCheck')).rejects.toThrow();

    expect(mockLoggerWarn).toHaveBeenCalled();
    for (const call of mockLoggerWarn.mock.calls) {
      const msg = String(call[0]);
      expect(msg).not.toMatch(/Bearer/i);
      expect(msg).not.toMatch(/Authorization/i);
      expect(msg).not.toMatch(/private_key/i);
      expect(msg).not.toMatch(/GOOGLE_PRIVATE_KEY/i);
      // Retry log lines should contain attempt count + the fileId only.
      expect(msg).toContain('attempt');
      expect(msg).toContain('leakCheck');
    }
  });
});

// ---------------------------------------------------------------------------
// Test 10: T-17-04 update-in-place survives retry — no duplicate file creates
// ---------------------------------------------------------------------------

describe('T-17-04: uploadToDrive update-in-place survives retry on files.update', () => {
  it('when an existing file is found, files.update retries but files.create is never called', async () => {
    const m = makeMockDrive();
    m.filesList
      .mockResolvedValueOnce({ data: { files: [{ id: 'SUPPLIER_FOLDER' }] } })
      .mockResolvedValueOnce({ data: { files: [{ id: 'STYLE_FOLDER' }] } })
      // Existing file present — update path is taken.
      .mockResolvedValueOnce({ data: { files: [{ id: 'EXISTING' }] } });

    m.filesUpdate
      .mockRejectedValueOnce(timeoutErr('ECONNABORTED'))
      .mockResolvedValueOnce({ data: {} });

    const { uploadToDrive } = await import('../../src/sheets/drive.js');
    const url = await uploadToDrive(
      m.drive as never,
      Buffer.from([1, 2, 3]),
      'front.png',
      'CSW',
      '5000',
    );

    // Updated, never created.
    expect(url).toContain('EXISTING');
    expect(m.filesUpdate).toHaveBeenCalledTimes(2);
    expect(m.filesCreate).not.toHaveBeenCalled();
    expect(m.permissionsCreate).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Test 11: timeout constants exist in source — magic-number guard
// ---------------------------------------------------------------------------

describe('Test 11: DRIVE_TIMEOUT_MS + DRIVE_RETRY_MAX named constants in source', () => {
  it('src/sheets/drive.ts declares DRIVE_TIMEOUT_MS = 30_000 and DRIVE_RETRY_MAX = 2', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const url = await import('url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const driveSrc = fs.readFileSync(
      path.join(here, '..', '..', 'src', 'sheets', 'drive.ts'),
      'utf-8',
    );
    expect(driveSrc).toMatch(/^const DRIVE_TIMEOUT_MS = 30_000/m);
    expect(driveSrc).toMatch(/^const DRIVE_RETRY_MAX = 2/m);
    // The helper is defined and used.
    expect(driveSrc).toMatch(/function withDriveRetry/);
    expect(driveSrc).toMatch(/function isTimeoutError/);
  });
});
