// @vitest-environment jsdom
import {beforeEach, describe, expect, it, vi} from 'vitest';
const native = vi.hoisted(() => ({isNativeApp: vi.fn(), saveWrappedBackup: vi.fn()}));
vi.mock('./native', () => ({isNativeApp: native.isNativeApp, SignetNative: {saveWrappedBackup: native.saveWrappedBackup}}));
import {saveWrappedBackupFile, saveAccountCollectionFile} from './wrapped-backup-file';

const record = 'nstw1:' + 'A'.repeat(175);
describe('encrypted backup file export', () => {
  beforeEach(() => {vi.resetAllMocks();});
  it('uses the Android document picker and reports cancellation without a browser fallback', async () => {
    native.isNativeApp.mockReturnValue(true);
    native.saveWrappedBackup.mockResolvedValueOnce({saved: true}).mockResolvedValueOnce({saved: false});
    expect(await saveWrappedBackupFile(record)).toBe(true);
    expect(native.saveWrappedBackup).toHaveBeenCalledWith({record});
    expect(await saveWrappedBackupFile(record)).toBe(false);
    native.saveWrappedBackup.mockRejectedValueOnce(new Error('write failed'));
    await expect(saveWrappedBackupFile(record)).rejects.toThrow('write failed');
  });
  it('does not send raw key material or oversized data to the native file writer', async () => {
    native.isNativeApp.mockReturnValue(true);
    await expect(saveWrappedBackupFile('22'.repeat(32))).rejects.toThrow();
    await expect(saveWrappedBackupFile(record + 'A')).rejects.toThrow();
    await expect(saveWrappedBackupFile(record + '\n')).rejects.toThrow();
    expect(native.saveWrappedBackup).not.toHaveBeenCalled();
  });
  it('passes only a bounded FSWNENC2 collection through the native document picker', async () => {
    native.isNativeApp.mockReturnValue(true);
    native.saveWrappedBackup.mockResolvedValue({saved: true});
    const file = new Uint8Array(65_608); file.set(new TextEncoder().encode('FSWNENC2'));
    expect(await saveAccountCollectionFile(file)).toBe(true);
    expect(native.saveWrappedBackup.mock.calls[0][0].record).toMatch(/^nstc1:[A-Za-z0-9_-]+$/);
    await expect(saveAccountCollectionFile(file.subarray(1))).rejects.toThrow();
    await expect(saveAccountCollectionFile(new Uint8Array(65_608))).rejects.toThrow();
    expect(native.saveWrappedBackup).toHaveBeenCalledTimes(1);
  });
});
