/**
 * Tests for the 4 new exports on src/sheets/drive.ts (Phase 16 Plan 01 Task 1):
 *   extractFileId, downloadFromDrive, trashDriveFile, getDriveFileMetadata.
 *
 * The existing exports (createDriveClient, uploadToDrive) are NOT covered here
 * (they require real Google credentials and exist pre-Phase-16). Only the new
 * helpers added in this plan are tested.
 *
 * All Drive API calls are mocked via a hand-rolled drive_v3.Drive shape. No
 * real network requests, no service account.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock: logger
// ---------------------------------------------------------------------------

const mockLoggerInfo = vi.fn();
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: mockLoggerInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Mock: googleapis — prevent real auth client instantiation
// ---------------------------------------------------------------------------

vi.mock('googleapis', () => ({
  google: {
    drive: vi.fn(),
    auth: { GoogleAuth: vi.fn() },
  },
}));

// ---------------------------------------------------------------------------
// Helper: minimal drive_v3.Drive shape used by the 4 helpers
// ---------------------------------------------------------------------------

function makeMockDrive() {
  const filesGet = vi.fn();
  const filesUpdate = vi.fn();
  const drive = {
    files: {
      get: filesGet,
      update: filesUpdate,
    },
  };
  return { drive, filesGet, filesUpdate };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Test K: extractFileId — uc?id=... URL
// ---------------------------------------------------------------------------

describe('extractFileId — uc?id format', () => {
  it('returns the fileId from https://drive.google.com/uc?id=...', async () => {
    const { extractFileId } = await import('../../src/sheets/drive.js');
    expect(extractFileId('https://drive.google.com/uc?id=abc123def456ghi789jk')).toBe(
      'abc123def456ghi789jk',
    );
  });
});

// ---------------------------------------------------------------------------
// Test L: extractFileId — /file/d/<id>/view URL
// ---------------------------------------------------------------------------

describe('extractFileId — /file/d/ format', () => {
  it('returns the fileId from https://drive.google.com/file/d/<id>/view', async () => {
    const { extractFileId } = await import('../../src/sheets/drive.js');
    expect(extractFileId('https://drive.google.com/file/d/abc123def456ghi789jk/view')).toBe(
      'abc123def456ghi789jk',
    );
  });
});

// ---------------------------------------------------------------------------
// Test M: extractFileId — empty or non-Drive URL → null
// ---------------------------------------------------------------------------

describe('extractFileId — empty and non-Drive URLs', () => {
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
// Test N: downloadFromDrive — invokes files.get with alt=media + arraybuffer
// ---------------------------------------------------------------------------

describe('downloadFromDrive', () => {
  it('calls drive.files.get with media+arraybuffer params and returns a Buffer', async () => {
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
    expect(opts).toEqual({ responseType: 'arraybuffer' });

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBe(4);
    expect(buffer[0]).toBe(1);
    expect(buffer[3]).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Test O: trashDriveFile — invokes files.update with trashed=true
// ---------------------------------------------------------------------------

describe('trashDriveFile', () => {
  it('calls drive.files.update with trashed=true and supportsAllDrives=true', async () => {
    const { drive, filesUpdate } = makeMockDrive();
    filesUpdate.mockResolvedValueOnce({ data: {} });

    const { trashDriveFile } = await import('../../src/sheets/drive.js');
    const result = await trashDriveFile(drive as never, 'fileId123');

    expect(result).toBeUndefined();
    expect(filesUpdate).toHaveBeenCalledTimes(1);
    expect(filesUpdate.mock.calls[0][0]).toEqual({
      fileId: 'fileId123',
      requestBody: { trashed: true },
      supportsAllDrives: true,
    });

    // Logs an info line with [drive] prefix
    expect(mockLoggerInfo).toHaveBeenCalled();
    const firstLogMsg = String(mockLoggerInfo.mock.calls[0][0]);
    expect(firstLogMsg).toContain('[drive]');
    expect(firstLogMsg).toContain('fileId123');
  });
});

// ---------------------------------------------------------------------------
// Test P: getDriveFileMetadata — invokes files.get with fields=...
// ---------------------------------------------------------------------------

describe('getDriveFileMetadata', () => {
  it('calls drive.files.get with metadata fields and returns {mimeType,size,name}', async () => {
    const { drive, filesGet } = makeMockDrive();
    filesGet.mockResolvedValueOnce({
      data: { mimeType: 'image/png', size: '12345', name: 'front.png' },
    });

    const { getDriveFileMetadata } = await import('../../src/sheets/drive.js');
    const result = await getDriveFileMetadata(drive as never, 'fileId123');

    expect(filesGet).toHaveBeenCalledTimes(1);
    expect(filesGet.mock.calls[0][0]).toEqual({
      fileId: 'fileId123',
      fields: 'mimeType,size,name',
      supportsAllDrives: true,
    });

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
});
