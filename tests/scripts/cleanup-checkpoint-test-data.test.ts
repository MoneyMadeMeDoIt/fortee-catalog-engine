/**
 * Smoke tests for scripts/cleanup-checkpoint-test-data.ts — Phase 17-07 (B-3 fix).
 *
 * Covers the new MANUAL/ scan path added to close the cleanup blind spot. Phase 16's
 * checkpoint flow uploads FORCE-replacement images via fix-image-pollution-manual.ts
 * `handleReplace`, which hardcodes supplierCode='MANUAL'. The cleanup script previously
 * only scanned CHECKPOINT-TEST/, leaving MANUAL/CHECKPOINT-TEST-(NNN)/ orphans behind.
 *
 * 7 tests:
 *   1  Existing CHECKPOINT-TEST/ scan still runs when MANUAL/ is absent
 *   2  Both scans run when both folders exist; counts add up
 *   3  MANUAL/ exists but has no CHECKPOINT-TEST-* subfolders → MANUAL no-op
 *   4  T-17-23 — MANUAL/<real-pid>/ folders (e.g. S05610) NEVER touched
 *   5  T-17-24 — MANUAL/ parent folder itself NEVER trashed
 *   6  Idempotent — re-run with everything already trashed = zero trash calls
 *   7  TEST_PIDS env constant integrity (exact array contents exported)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runCleanup,
  TEST_PIDS,
  type CleanupDeps,
} from '../../scripts/cleanup-checkpoint-test-data.js';

// Helper: tiny synthetic drive-client stub. The DI seam never invokes real Drive,
// but the script still constructs an object that gets passed through to the mocked
// per-pid `drive.files.list` calls inside trashCheckpointArtifactsInManualFolder.
// We expose a `files.list` mock here that callers can configure per-test.
function makeDriveStub(filesListImpl?: ReturnType<typeof vi.fn>): {
  files: { list: ReturnType<typeof vi.fn> };
} {
  return {
    files: {
      list: filesListImpl ?? vi.fn().mockResolvedValue({ data: { files: [] } }),
    },
  };
}

// Helper: build a default deps object. Tests override one or two fields.
function makeDeps(overrides: Partial<CleanupDeps> = {}): CleanupDeps {
  const driveClient = makeDriveStub();
  const sheetsClient = {} as never;

  const trashDriveFileFn = vi.fn().mockResolvedValue(undefined);
  const findSupplierFolderIdFn = vi.fn().mockResolvedValue(null);
  const findManualFolderIdFn = vi.fn().mockResolvedValue(null);
  const listAllDescendantFilesFn = vi.fn().mockResolvedValue([]);
  const deleteBrRowsFn = vi.fn().mockResolvedValue(0);

  return {
    driveClient: driveClient as never,
    sheetsClient,
    trashDriveFileFn: trashDriveFileFn as never,
    findSupplierFolderIdFn: findSupplierFolderIdFn as never,
    findManualFolderIdFn: findManualFolderIdFn as never,
    listAllDescendantFilesFn: listAllDescendantFilesFn as never,
    deleteBrRowsFn: deleteBrRowsFn as never,
    ...overrides,
  };
}

describe('cleanup-checkpoint-test-data — runCleanup (DI seam) — Phase 17-07', () => {
  beforeEach(() => vi.clearAllMocks());

  it('Test 1: existing CHECKPOINT-TEST/ scan still runs when MANUAL/ is absent', async () => {
    // CHECKPOINT-TEST/ folder found with 3 descendant files.
    // MANUAL/ folder absent (findManualFolderIdFn → null).
    const ctDescendants = [
      { id: 'CT-F1', name: 'CHECKPOINT-TEST-001_FrontImage.png' },
      { id: 'CT-F2', name: 'CHECKPOINT-TEST-001_BackImage.png' },
      { id: 'CT-F3', name: 'CHECKPOINT-TEST-002_FrontImage.png' },
    ];
    const findSupplierFolderIdFn = vi.fn().mockResolvedValue('CT-FOLDER-ID');
    const findManualFolderIdFn = vi.fn().mockResolvedValue(null);
    const listAllDescendantFilesFn = vi
      .fn()
      .mockImplementation((_drive: unknown, folderId: string) => {
        if (folderId === 'CT-FOLDER-ID') return Promise.resolve(ctDescendants);
        return Promise.resolve([]);
      });
    const trashDriveFileFn = vi.fn().mockResolvedValue(undefined);

    const deps = makeDeps({
      findSupplierFolderIdFn: findSupplierFolderIdFn as never,
      findManualFolderIdFn: findManualFolderIdFn as never,
      listAllDescendantFilesFn: listAllDescendantFilesFn as never,
      trashDriveFileFn: trashDriveFileFn as never,
    });

    const result = await runCleanup(deps);

    // 3 descendants + 1 parent (CT-FOLDER-ID) = 4 trash calls total.
    expect(trashDriveFileFn).toHaveBeenCalledTimes(4);
    expect(trashDriveFileFn).toHaveBeenCalledWith(deps.driveClient, 'CT-F1');
    expect(trashDriveFileFn).toHaveBeenCalledWith(deps.driveClient, 'CT-F2');
    expect(trashDriveFileFn).toHaveBeenCalledWith(deps.driveClient, 'CT-F3');
    expect(trashDriveFileFn).toHaveBeenCalledWith(deps.driveClient, 'CT-FOLDER-ID');
    expect(result.ctTrashed).toBe(3);
    expect(result.manualTrashed).toBe(0);
  });

  it('Test 2: CHECKPOINT-TEST/ + MANUAL/CHECKPOINT-TEST-{001,002}/ both scanned, counts add up', async () => {
    // CT side: 2 descendants
    const ctDescendants = [
      { id: 'CT-F1', name: 'CHECKPOINT-TEST-001_BackImage.png' },
      { id: 'CT-F2', name: 'CHECKPOINT-TEST-002_DirectSideImage.png' },
    ];
    // MANUAL side: 1 descendant under each test pid
    const manual001Descendants = [{ id: 'M-001-F1', name: 'replacement-back.png' }];
    const manual002Descendants = [{ id: 'M-002-F1', name: 'replacement-side.png' }];

    const findSupplierFolderIdFn = vi.fn().mockResolvedValue('CT-FOLDER');
    const findManualFolderIdFn = vi.fn().mockResolvedValue('MANUAL-FOLDER');
    const listAllDescendantFilesFn = vi
      .fn()
      .mockImplementation((_drive: unknown, folderId: string) => {
        if (folderId === 'CT-FOLDER') return Promise.resolve(ctDescendants);
        if (folderId === 'M-001-FOLDER') return Promise.resolve(manual001Descendants);
        if (folderId === 'M-002-FOLDER') return Promise.resolve(manual002Descendants);
        return Promise.resolve([]);
      });
    const trashDriveFileFn = vi.fn().mockResolvedValue(undefined);

    // The script queries drive.files.list inside MANUAL/ for each TEST_PID — return
    // the per-pid folder id depending on the query.
    const filesListMock = vi.fn().mockImplementation((req: { q?: string }) => {
      const q = req?.q ?? '';
      if (q.includes("name = 'CHECKPOINT-TEST-001'")) {
        return Promise.resolve({
          data: { files: [{ id: 'M-001-FOLDER', name: 'CHECKPOINT-TEST-001' }] },
        });
      }
      if (q.includes("name = 'CHECKPOINT-TEST-002'")) {
        return Promise.resolve({
          data: { files: [{ id: 'M-002-FOLDER', name: 'CHECKPOINT-TEST-002' }] },
        });
      }
      return Promise.resolve({ data: { files: [] } });
    });
    const driveClient = makeDriveStub(filesListMock);

    const deps = makeDeps({
      driveClient: driveClient as never,
      findSupplierFolderIdFn: findSupplierFolderIdFn as never,
      findManualFolderIdFn: findManualFolderIdFn as never,
      listAllDescendantFilesFn: listAllDescendantFilesFn as never,
      trashDriveFileFn: trashDriveFileFn as never,
    });

    const result = await runCleanup(deps);

    // Expected trash calls:
    //   CT descendants: 2 (CT-F1, CT-F2)
    //   CT parent folder: 1 (CT-FOLDER)
    //   MANUAL/CHECKPOINT-TEST-001 descendants: 1 (M-001-F1)
    //   MANUAL/CHECKPOINT-TEST-001 folder itself: 1 (M-001-FOLDER)
    //   MANUAL/CHECKPOINT-TEST-002 descendants: 1 (M-002-F1)
    //   MANUAL/CHECKPOINT-TEST-002 folder itself: 1 (M-002-FOLDER)
    // Total: 7
    expect(trashDriveFileFn).toHaveBeenCalledTimes(7);
    expect(trashDriveFileFn).toHaveBeenCalledWith(deps.driveClient, 'M-001-F1');
    expect(trashDriveFileFn).toHaveBeenCalledWith(deps.driveClient, 'M-001-FOLDER');
    expect(trashDriveFileFn).toHaveBeenCalledWith(deps.driveClient, 'M-002-F1');
    expect(trashDriveFileFn).toHaveBeenCalledWith(deps.driveClient, 'M-002-FOLDER');

    expect(result.ctTrashed).toBe(2);
    expect(result.manualTrashed).toBe(2); // 1 per test pid
  });

  it('Test 3: MANUAL/ exists but no CHECKPOINT-TEST-* subfolders → MANUAL no-op; CT side still runs', async () => {
    const ctDescendants = [{ id: 'CT-F1', name: 'orphan.png' }];
    const findSupplierFolderIdFn = vi.fn().mockResolvedValue('CT-FOLDER');
    const findManualFolderIdFn = vi.fn().mockResolvedValue('MANUAL-FOLDER');
    const listAllDescendantFilesFn = vi
      .fn()
      .mockImplementation((_d: unknown, fid: string) =>
        fid === 'CT-FOLDER' ? Promise.resolve(ctDescendants) : Promise.resolve([]),
      );
    const trashDriveFileFn = vi.fn().mockResolvedValue(undefined);

    // Per-pid lookup always returns empty (no CHECKPOINT-TEST-* under MANUAL/)
    const filesListMock = vi.fn().mockResolvedValue({ data: { files: [] } });
    const driveClient = makeDriveStub(filesListMock);

    const deps = makeDeps({
      driveClient: driveClient as never,
      findSupplierFolderIdFn: findSupplierFolderIdFn as never,
      findManualFolderIdFn: findManualFolderIdFn as never,
      listAllDescendantFilesFn: listAllDescendantFilesFn as never,
      trashDriveFileFn: trashDriveFileFn as never,
    });

    const result = await runCleanup(deps);

    // Only CT side: 1 descendant + 1 parent = 2 trash calls. No MANUAL trash calls.
    expect(trashDriveFileFn).toHaveBeenCalledTimes(2);
    expect(trashDriveFileFn).toHaveBeenCalledWith(deps.driveClient, 'CT-F1');
    expect(trashDriveFileFn).toHaveBeenCalledWith(deps.driveClient, 'CT-FOLDER');
    expect(result.manualTrashed).toBe(0);

    // Per-pid lookup MUST have been attempted for each TEST_PID inside MANUAL/.
    // (One call per pid: 'CHECKPOINT-TEST-001' and 'CHECKPOINT-TEST-002'.)
    const queriedNames = filesListMock.mock.calls
      .map((c: unknown[]) => (c[0] as { q?: string })?.q ?? '')
      .filter((q: string) => q.includes("'MANUAL-FOLDER'"));
    expect(queriedNames.length).toBeGreaterThanOrEqual(2);
  });

  it('Test 4 (T-17-23): MANUAL/ contains real operator pid S05610 alongside CHECKPOINT-TEST-001 — S05610 NEVER touched', async () => {
    // CT side: empty (no CHECKPOINT-TEST/ folder)
    const findSupplierFolderIdFn = vi.fn().mockResolvedValue(null);
    const findManualFolderIdFn = vi.fn().mockResolvedValue('MANUAL-FOLDER');

    // Per-pid lookup: CHECKPOINT-TEST-001 found; CHECKPOINT-TEST-002 not found.
    // The S05610 folder is NEVER queried because the scan only enumerates exact-match TEST_PIDS.
    const filesListMock = vi.fn().mockImplementation((req: { q?: string }) => {
      const q = req?.q ?? '';
      if (q.includes("name = 'CHECKPOINT-TEST-001'")) {
        return Promise.resolve({
          data: { files: [{ id: 'M-001-FOLDER', name: 'CHECKPOINT-TEST-001' }] },
        });
      }
      // For 'CHECKPOINT-TEST-002': empty.
      // For any other name (e.g., 'S05610'): empty. But we should NEVER see such a query.
      return Promise.resolve({ data: { files: [] } });
    });
    const driveClient = makeDriveStub(filesListMock);

    const listAllDescendantFilesFn = vi
      .fn()
      .mockImplementation((_d: unknown, fid: string) =>
        fid === 'M-001-FOLDER'
          ? Promise.resolve([{ id: 'M-001-F1', name: 'replacement.png' }])
          : Promise.resolve([]),
      );
    const trashDriveFileFn = vi.fn().mockResolvedValue(undefined);

    const deps = makeDeps({
      driveClient: driveClient as never,
      findSupplierFolderIdFn: findSupplierFolderIdFn as never,
      findManualFolderIdFn: findManualFolderIdFn as never,
      listAllDescendantFilesFn: listAllDescendantFilesFn as never,
      trashDriveFileFn: trashDriveFileFn as never,
    });

    await runCleanup(deps);

    // Assert: no query was issued for any name other than the exact TEST_PIDS.
    const queriedNamePatterns = filesListMock.mock.calls
      .map((c: unknown[]) => (c[0] as { q?: string })?.q ?? '')
      .filter((q: string) => q.includes("'MANUAL-FOLDER'"));
    for (const q of queriedNamePatterns) {
      // Every MANUAL-FOLDER query must target one of the TEST_PIDS exactly.
      const hasTestPid = TEST_PIDS.some((pid) => q.includes(`name = '${pid}'`));
      expect(hasTestPid).toBe(true);
      expect(q).not.toContain("name = 'S05610'");
    }

    // Assert: no trash call referenced anything S05610-related.
    for (const call of trashDriveFileFn.mock.calls) {
      expect(String(call[1])).not.toContain('S05610');
    }
  });

  it('Test 5 (T-17-24): MANUAL/ parent folder is NEVER trashed', async () => {
    const findSupplierFolderIdFn = vi.fn().mockResolvedValue('CT-FOLDER');
    const findManualFolderIdFn = vi.fn().mockResolvedValue('MANUAL-FOLDER');

    const filesListMock = vi.fn().mockImplementation((req: { q?: string }) => {
      const q = req?.q ?? '';
      if (q.includes("name = 'CHECKPOINT-TEST-001'")) {
        return Promise.resolve({
          data: { files: [{ id: 'M-001-FOLDER', name: 'CHECKPOINT-TEST-001' }] },
        });
      }
      if (q.includes("name = 'CHECKPOINT-TEST-002'")) {
        return Promise.resolve({
          data: { files: [{ id: 'M-002-FOLDER', name: 'CHECKPOINT-TEST-002' }] },
        });
      }
      return Promise.resolve({ data: { files: [] } });
    });
    const driveClient = makeDriveStub(filesListMock);

    const listAllDescendantFilesFn = vi.fn().mockResolvedValue([]);
    const trashDriveFileFn = vi.fn().mockResolvedValue(undefined);

    const deps = makeDeps({
      driveClient: driveClient as never,
      findSupplierFolderIdFn: findSupplierFolderIdFn as never,
      findManualFolderIdFn: findManualFolderIdFn as never,
      listAllDescendantFilesFn: listAllDescendantFilesFn as never,
      trashDriveFileFn: trashDriveFileFn as never,
    });

    await runCleanup(deps);

    // T-17-24: MANUAL-FOLDER (the parent) must NEVER be trashed.
    // Per-pid subfolders (M-001-FOLDER, M-002-FOLDER) are allowed to be trashed.
    // The CHECKPOINT-TEST root folder (CT-FOLDER) is allowed to be trashed.
    const allTrashedIds = trashDriveFileFn.mock.calls.map((c: unknown[]) => String(c[1]));
    expect(allTrashedIds).not.toContain('MANUAL-FOLDER');
    // Sanity check: the per-pid subfolders WERE trashed.
    expect(allTrashedIds).toContain('M-001-FOLDER');
    expect(allTrashedIds).toContain('M-002-FOLDER');
  });

  it('Test 6: idempotent re-run — nothing left to trash, zero trash calls', async () => {
    // All scans return empty: CT folder absent, MANUAL folder absent.
    const findSupplierFolderIdFn = vi.fn().mockResolvedValue(null);
    const findManualFolderIdFn = vi.fn().mockResolvedValue(null);
    const trashDriveFileFn = vi.fn().mockResolvedValue(undefined);
    const listAllDescendantFilesFn = vi.fn().mockResolvedValue([]);
    const deleteBrRowsFn = vi.fn().mockResolvedValue(0);

    const deps = makeDeps({
      findSupplierFolderIdFn: findSupplierFolderIdFn as never,
      findManualFolderIdFn: findManualFolderIdFn as never,
      trashDriveFileFn: trashDriveFileFn as never,
      listAllDescendantFilesFn: listAllDescendantFilesFn as never,
      deleteBrRowsFn: deleteBrRowsFn as never,
    });

    const result = await runCleanup(deps);

    expect(trashDriveFileFn).not.toHaveBeenCalled();
    expect(result.ctTrashed).toBe(0);
    expect(result.manualTrashed).toBe(0);
    expect(result.brRowsDeleted).toBe(0);
  });

  it('Test 7: TEST_PIDS env constant integrity', () => {
    expect(TEST_PIDS).toEqual(['CHECKPOINT-TEST-001', 'CHECKPOINT-TEST-002']);
  });
});
