import { describe, expect, it, vi } from 'vitest';
import type { BrowserTab } from './bookmarks';
import {
  inspectTabMedia,
  isMediaPlaybackChangedMessage,
  mediaControlMessageType,
  mediaPlaybackChangedMessageType,
  pausePlayingTabMedia,
  selectMediaControlTarget,
  setTabMediaPlayback,
} from './mediaControl';
import { backgroundMusicTabIds, mediaControlTabs } from './mediaState';

const target = (frameId: number, elementIndex: number, state: 'paused' | 'playing') =>
  ({ tabId: 17, frameId, elementIndex, state });
const audioTab = (id: number, audible: boolean) => ({ id, windowId: 3, audible }) as BrowserTab;

describe('isMediaPlaybackChangedMessage', () => {
  it('accepts only page playback state notifications', () => {
    expect(isMediaPlaybackChangedMessage({ type: mediaPlaybackChangedMessageType, state: 'playing' })).toBe(true);
    expect(isMediaPlaybackChangedMessage({ type: mediaPlaybackChangedMessageType, state: 'paused' })).toBe(true);
    expect(isMediaPlaybackChangedMessage({ type: mediaPlaybackChangedMessageType, state: 'buffering' })).toBe(false);
    expect(isMediaPlaybackChangedMessage({ type: mediaControlMessageType, state: 'paused' })).toBe(false);
  });
});

describe('selectMediaControlTarget', () => {
  it('prefers actively playing media across frames', () => {
    expect(selectMediaControlTarget(17, [
      { frameId: 0, result: { elementIndex: 2, state: 'paused' } },
      { frameId: 4, result: { elementIndex: 1, state: 'playing' } },
    ])).toEqual(target(4, 1, 'playing'));
  });

  it('uses resumable paused media when nothing is playing', () => {
    expect(selectMediaControlTarget(17, [
      { frameId: 0, result: null },
      { frameId: 7, result: { elementIndex: 3, state: 'paused' } },
    ])).toEqual(target(7, 3, 'paused'));
  });

  it('returns no control for tabs without supported media', () => {
    expect(selectMediaControlTarget(17, [
      { frameId: 0, result: null },
      { frameId: 2 },
    ])).toBeUndefined();
  });
});

describe('mediaControlTabs', () => {
  it('retains a controlled tab after pausing clears its audible state', () => {
    const tab = audioTab(17, false);

    expect(mediaControlTabs([tab], 3, target(0, 0, 'paused'))).toEqual([tab]);
  });

  it('prefers tabs that are currently audible over a retained session', () => {
    const paused = audioTab(17, false);
    const audible = audioTab(19, true);

    expect(mediaControlTabs([paused, audible], 3, target(0, 0, 'paused'))).toEqual([audible]);
  });

  it('puts the latest retained audible tab first', () => {
    const first = audioTab(17, true);
    const latest = audioTab(19, true);

    expect(mediaControlTabs([first, latest], 3, undefined, 19))
      .toEqual([latest, first]);
  });

  it('retains the last media tab while availability is being rechecked', () => {
    const tab = audioTab(17, false);

    expect(mediaControlTabs([tab], 3, undefined, 17)).toEqual([tab]);
    expect(mediaControlTabs([tab], 3)).toEqual([]);
  });
});

describe('content-script media control', () => {
  it('pauses each existing tab that is still playing', async () => {
    const sendMessage = vi.fn(async (
      tabId: number,
      message: { action: string; state?: string },
    ) => message.action === 'inspect'
      ? { elementIndex: 0, state: tabId === 17 ? 'playing' as const : 'paused' as const }
      : { elementIndex: 0, state: message.state as 'paused' });
    vi.stubGlobal('browser', {
      tabs: { sendMessage },
      webNavigation: { getAllFrames: vi.fn(async () => [{ frameId: 0 }]) },
    });
    try {
      await pausePlayingTabMedia([17, 19]);
      expect(sendMessage).toHaveBeenCalledWith(17, {
        type: mediaControlMessageType,
        action: 'set-playback',
        elementIndex: 0,
        state: 'paused',
      }, { frameId: 0 });
      expect(sendMessage).not.toHaveBeenCalledWith(19, expect.objectContaining({
        action: 'set-playback',
      }), expect.anything());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('selects playing media reported by any tab frame', async () => {
    const sendMessage = vi.fn(async (
      _tabId: number,
      _message: unknown,
      options: { frameId: number },
    ) => options.frameId === 4
      ? { elementIndex: 2, state: 'playing' as const }
      : null);
    vi.stubGlobal('browser', {
      tabs: { sendMessage },
      webNavigation: {
        getAllFrames: vi.fn(async () => [{ frameId: 0 }, { frameId: 4 }]),
      },
    });
    try {
      await expect(inspectTabMedia(17)).resolves.toEqual({
        reachable: true,
        target: target(4, 2, 'playing'),
      });
      expect(sendMessage).toHaveBeenCalledWith(17, {
        type: mediaControlMessageType,
        action: 'inspect',
      }, { frameId: 4 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('tells a page Hyper cannot reach from one without a player', async () => {
    const unreachable = new Error('Could not establish connection. Receiving end does not exist.');
    const answeringFrames = new Set<number>();
    const sendMessage = vi.fn(async (_tabId: number, _message: unknown, options: { frameId: number }) => {
      if (!answeringFrames.has(options.frameId)) throw unreachable;
      return null;
    });
    const executeScript = vi.fn();
    vi.stubGlobal('browser', {
      tabs: { sendMessage },
      webNavigation: { getAllFrames: vi.fn(async () => [{ frameId: 0 }, { frameId: 4 }]) },
    });
    vi.stubGlobal('chrome', {});
    try {
      await expect(inspectTabMedia(17)).resolves.toEqual({ reachable: false });

      // A frame added since Hyper reloaded answers, but the page itself does not.
      answeringFrames.add(4);
      await expect(inspectTabMedia(17)).resolves.toEqual({ reachable: false });

      answeringFrames.add(0);
      await expect(inspectTabMedia(17)).resolves.toEqual({ reachable: true });

      answeringFrames.clear();
      vi.stubGlobal('chrome', { scripting: { executeScript } });
      executeScript.mockRejectedValueOnce(new Error('Cannot access contents of the page.'));
      await expect(inspectTabMedia(17)).resolves.toEqual({ reachable: false });

      executeScript.mockResolvedValueOnce([{ frameId: 0, result: null }]);
      await expect(inspectTabMedia(17)).resolves.toEqual({ reachable: true });

      executeScript.mockResolvedValueOnce([{ frameId: 0, result: { elementIndex: 1, state: 'paused' } }]);
      await expect(inspectTabMedia(17)).resolves.toEqual({
        reachable: true,
        target: target(0, 1, 'paused'),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sets playback in the retained target frame', async () => {
    const sendMessage = vi.fn(async () => ({
      elementIndex: 2,
      state: 'paused' as const,
    }));
    vi.stubGlobal('browser', {
      tabs: { sendMessage },
      webNavigation: { getAllFrames: vi.fn() },
    });
    try {
      await expect(setTabMediaPlayback(target(4, 2, 'playing'), 'paused')).resolves.toEqual(target(4, 2, 'paused'));
      expect(sendMessage).toHaveBeenCalledWith(17, {
        type: mediaControlMessageType,
        action: 'set-playback',
        elementIndex: 2,
        state: 'paused',
      }, { frameId: 4 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('propagates a messaging failure when no scripting fallback exists', async () => {
    vi.stubGlobal('browser', {
      tabs: { sendMessage: vi.fn().mockRejectedValue(new Error('Frame was replaced')) },
      webNavigation: { getAllFrames: vi.fn() },
    });
    vi.stubGlobal('chrome', {});
    try {
      await expect(setTabMediaPlayback(target(4, 2, 'playing'), 'paused')).rejects.toThrow('Frame was replaced');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('backgroundMusicTabIds', () => {
  const music = { id: 5, windowId: 3, audible: false, url: 'https://open.spotify.com/' } as BrowserTab;
  const other = { id: 6, windowId: 3, audible: true, url: 'https://www.youtube.com/watch?v=a' } as BrowserTab;
  const elsewhere = { id: 7, windowId: 4, audible: false, url: 'https://music.youtube.com/' } as BrowserTab;

  it('lists this window\u2019s music tabs while Now Playing is shown', () => {
    expect(backgroundMusicTabIds([music, other, elsewhere], 3)).toEqual([5]);
  });

  it('lists nothing while Now Playing is hidden', () => {
    expect(backgroundMusicTabIds([music, { ...other, audible: false }], 3)).toEqual([]);
  });
});
