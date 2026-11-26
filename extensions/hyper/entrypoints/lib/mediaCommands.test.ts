import { describe, expect, it, vi } from 'vitest';
import type { BrowserTab } from './bookmarks';
import {
  mediaCommandAction,
  mediaCommandActions,
  mediaCommands,
  windowMediaCommands,
  type MediaCommandContext,
  type MediaCommandHandlers,
} from './mediaCommands';
import type { MediaControlTarget } from './mediaControl';
import {
  createHyperModelStore,
  hyperModelAtom,
} from './model';
import { commitTestSources } from './testFixtures';

function tab(id: number, overrides: Partial<BrowserTab> = {}): BrowserTab {
  return {
    active: false,
    audible: false,
    id,
    index: id,
    title: `Tab ${id}`,
    url: `https://music.example/${id}`,
    windowId: 1,
    ...overrides,
  } as BrowserTab;
}

function target(tabId: number, state: MediaControlTarget['state']): MediaControlTarget {
  return { elementIndex: 0, frameId: 0, state, tabId };
}

function context(overrides: Partial<MediaCommandContext> = {}): MediaCommandContext {
  return {
    activeTabId: 1,
    mediaControlAvailable: true,
    tabs: [tab(1, { active: true }), tab(5, { audible: true, title: 'Live set' })],
    windowId: 1,
    ...overrides,
  };
}

const ids = (commandContext: MediaCommandContext) =>
  mediaCommands(commandContext).map((command) => command.id);

function handlers(overrides: Partial<MediaCommandHandlers> = {}): MediaCommandHandlers {
  return {
    focus: vi.fn(async () => undefined),
    onError: vi.fn(),
    setMuted: vi.fn(async () => undefined),
    setPlayback: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('media commands', () => {
  it('pauses, plays and switches to the tab Now Playing shows', () => {
    expect(mediaCommands(context({ mediaTarget: target(5, 'playing') }))).toEqual([
      {
        detail: 'Live set',
        icon: 'pause',
        id: 'media:pause',
        keywords: ['music', 'audio', 'sound', 'media', 'now playing', 'stop'],
        label: 'Pause music',
        tabId: 5,
      },
      {
        detail: 'Live set',
        icon: 'music',
        id: 'media:focus',
        keywords: ['music', 'audio', 'sound', 'media', 'now playing', 'go to', 'show'],
        label: 'Switch to music',
        tabId: 5,
      },
    ]);
    // A paused player keeps Now Playing after its tab falls silent.
    expect(mediaCommands(context({
      mediaRetainedTabId: 5,
      mediaTarget: target(5, 'paused'),
      tabs: [tab(1, { active: true }), tab(5, { title: 'Live set' })],
    })).map(({ icon, id, label }) => ({ icon, id, label }))).toEqual([
      { icon: 'play', id: 'media:play', label: 'Play music' },
      { icon: 'music', id: 'media:focus', label: 'Switch to music' },
    ]);
  });

  it('mutes instead where Hyper cannot play or pause the player', () => {
    expect(ids(context())).toEqual(['media:mute', 'media:focus']);
    expect(ids(context({
      mediaControlAvailable: false,
      mediaTarget: target(5, 'playing'),
    }))).toEqual(['media:mute', 'media:focus']);
    expect(mediaCommands(context({
      tabs: [tab(1, { active: true }), tab(5, { audible: true, mutedInfo: { muted: true } })],
    })).map(({ icon, label }) => ({ icon, label }))).toEqual([
      { icon: 'sound', label: 'Unmute music' },
      { icon: 'music', label: 'Switch to music' },
    ]);
  });

  it('offers no switch to music already in front', () => {
    expect(ids(context({
      activeTabId: 5,
      mediaTarget: target(5, 'playing'),
    }))).toEqual(['media:pause']);
  });

  it('only switches to a silent tab whose player Now Playing has dimmed', () => {
    expect(ids(context({
      mediaRetainedTabId: 5,
      tabs: [tab(1, { active: true }), tab(5)],
    }))).toEqual(['media:focus']);
    expect(ids(context({
      mediaRetainedTabId: 5,
      mediaTarget: target(5, 'playing'),
      tabs: [tab(1, { active: true }), tab(5)],
    }))).toEqual(['media:focus']);
  });

  it('acts on the tab Now Playing shows first, with the player only when it is that tab', () => {
    const tabs = [
      tab(1, { active: true }),
      tab(5, { audible: true, title: 'Radio' }),
      tab(6, { audible: true, title: 'Live set' }),
    ];
    expect(mediaCommands(context({ mediaTarget: target(6, 'playing'), tabs }))[0])
      .toMatchObject({ detail: 'Live set', id: 'media:pause', tabId: 6 });
    expect(mediaCommands(context({
      mediaRetainedTabId: 5,
      mediaTarget: target(6, 'playing'),
      tabs,
    }))[0]).toMatchObject({ detail: 'Radio', id: 'media:mute', tabId: 5 });
  });

  it('offers nothing without music in the window', () => {
    expect(mediaCommands(context({ tabs: [tab(1, { active: true }), tab(5)] }))).toEqual([]);
    expect(mediaCommands(context({ windowId: 2 }))).toEqual([]);
    expect(mediaCommands(context({ windowId: null }))).toEqual([]);
  });

  it('names a tab without a title by its address', () => {
    expect(mediaCommands(context({
      tabs: [tab(5, { audible: true, title: ' ', url: 'https://music.example/live' })],
    }))[0]?.detail).toBe('https://music.example/live');
  });

  it('runs each command through its host and reports a failure instead of throwing', async () => {
    const host = handlers();
    const commands = mediaCommandActions(context({ mediaTarget: target(5, 'playing') }), host);
    for (const command of commands) await command.run();
    const play = mediaCommandAction({ ...commands[0]!, id: 'media:play' }, host);
    const mute = mediaCommandAction({ ...commands[0]!, id: 'media:mute' }, host);
    const unmute = mediaCommandAction({ ...commands[0]!, id: 'media:unmute' }, host);
    await play?.run();
    await mute?.run();
    await unmute?.run();

    expect(host.setPlayback).toHaveBeenNthCalledWith(1, 5, 'paused');
    expect(host.setPlayback).toHaveBeenNthCalledWith(2, 5, 'playing');
    expect(host.focus).toHaveBeenCalledWith(5);
    expect(host.setMuted).toHaveBeenNthCalledWith(1, 5, true);
    expect(host.setMuted).toHaveBeenNthCalledWith(2, 5, false);
    expect(host.onError).not.toHaveBeenCalled();

    const failing = handlers({
      focus: vi.fn(async () => { throw new Error('The tab is gone.'); }),
      setPlayback: vi.fn(() => Promise.reject(new Error(''))),
    });
    const [pause, focus] = mediaCommandActions(context({ mediaTarget: target(5, 'playing') }), failing);
    await expect(pause!.run()).resolves.toBeUndefined();
    await expect(focus!.run()).resolves.toBeUndefined();
    expect(failing.onError).toHaveBeenNthCalledWith(1, 'Playback could not be changed.');
    expect(failing.onError).toHaveBeenNthCalledWith(2, 'The tab is gone.');
  });

  it('runs only music commands that name their tab', () => {
    const descriptor = { detail: 'Live set', icon: 'music' as const, label: 'Switch to music' };
    expect(mediaCommandAction({ ...descriptor, id: 'media:focus' }, handlers())).toBeUndefined();
    expect(mediaCommandAction({ ...descriptor, id: 'space:focus', tabId: 5 }, handlers()))
      .toBeUndefined();
    expect(mediaCommandAction({ ...descriptor, id: 'media:toString', tabId: 5 }, handlers()))
      .toBeUndefined();
    expect(mediaCommandAction({ ...descriptor, id: 'media:focus', tabId: 5 }, handlers()))
      .toMatchObject({ id: 'media:focus', tabId: 5 });
  });

  it('builds a window\'s commands from a committed revision', () => {
    const store = createHyperModelStore();
    commitTestSources(store, {
      tabs: [
        tab(1, { active: true }),
        tab(5, { audible: true, title: 'Live set' }),
        tab(9, { active: true, audible: true, windowId: 2 }),
      ],
      windows: [
        { id: 1, incognito: false } as Browser.windows.Window,
        { id: 2, incognito: false } as Browser.windows.Window,
      ],
    }, {
      mediaControlAvailable: true,
      mediaStates: {
        5: { ...target(5, 'playing'), navigationVersion: 0, url: 'https://music.example/5' },
      },
    });
    const snapshot = store.get(hyperModelAtom);

    expect(windowMediaCommands(snapshot, 1).map(({ id, tabId }) => ({ id, tabId }))).toEqual([
      { id: 'media:pause', tabId: 5 },
      { id: 'media:focus', tabId: 5 },
    ]);
    expect(windowMediaCommands(snapshot, 2).map(({ id, tabId }) => ({ id, tabId }))).toEqual([
      { id: 'media:mute', tabId: 9 },
    ]);
  });
});
