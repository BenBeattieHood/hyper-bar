import { describe, expect, it, vi } from 'vitest';
import { renameTabDocumentTitle } from './tabDocumentTitle';

describe('renameTabDocumentTitle', () => {
  it('uses the MV3 scripting API when it is available', async () => {
    const executeScript = vi.fn(async () => undefined);

    await expect(renameTabDocumentTitle(7, 'Renamed tab', {
      scripting: { executeScript },
    })).resolves.toBe(true);

    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({
      args: ['Renamed tab'],
      target: { tabId: 7 },
    }));
  });

  it('falls back to the MV2 tabs API', async () => {
    const executeScript = vi.fn(async () => undefined);

    await expect(renameTabDocumentTitle(8, 'A "quoted" title', {
      tabs: { executeScript },
    })).resolves.toBe(true);

    expect(executeScript).toHaveBeenCalledWith(8, {
      code: 'document.title = "A \\"quoted\\" title"',
    });
  });

  it('keeps a backing rename successful when page scripting is unavailable', async () => {
    await expect(renameTabDocumentTitle(9, 'Unchanged page')).resolves.toBe(false);
  });

  it('keeps a backing rename successful when page scripting fails', async () => {
    await expect(renameTabDocumentTitle(10, 'Blocked page', {
      scripting: { executeScript: vi.fn(async () => { throw new Error('blocked'); }) },
    })).resolves.toBe(false);
  });
});