import type { BrowserTab } from './bookmarks';
import type { CommandAction, CommandIcon } from './commandBar';
import type { MediaControlTarget, MediaPlaybackState } from './mediaControl';
import { mediaTargetForWindow, nowPlayingTab } from './mediaState';
import type { HyperModelSnapshot } from './model';
import type { SearchCommand } from './searchIndex';
import { tabDisplayTitle } from './tabs';

export interface MediaCommandContext {
  /** The tab in front, which needs no switching to. */
  activeTabId?: number;
  mediaControlAvailable: boolean;
  mediaRetainedTabId?: number;
  mediaTarget?: MediaControlTarget;
  tabs: readonly BrowserTab[];
  windowId: number | null | undefined;
}

/** What a host does for a music command; a rejection is reported, never thrown. */
export interface MediaCommandHandlers {
  focus(tabId: number): Promise<unknown>;
  onError(message: string): void;
  setMuted(tabId: number, muted: boolean): Promise<unknown>;
  setPlayback(tabId: number, state: MediaPlaybackState): Promise<unknown>;
}

interface MediaCommandDefinition {
  failure: string;
  icon: CommandIcon;
  keywords: string[];
  label: string;
  run(handlers: MediaCommandHandlers, tabId: number): Promise<unknown>;
}

const MEDIA_KEYWORDS = ['music', 'audio', 'sound', 'media', 'now playing'];

const definitions = {
  pause: {
    failure: 'Playback could not be changed.',
    icon: 'pause',
    keywords: ['stop'],
    label: 'Pause music',
    run: (handlers, tabId) => handlers.setPlayback(tabId, 'paused'),
  },
  play: {
    failure: 'Playback could not be changed.',
    icon: 'play',
    keywords: ['resume', 'continue', 'unpause'],
    label: 'Play music',
    run: (handlers, tabId) => handlers.setPlayback(tabId, 'playing'),
  },
  mute: {
    failure: 'This tab could not be muted.',
    icon: 'mute',
    keywords: ['silence'],
    label: 'Mute music',
    run: (handlers, tabId) => handlers.setMuted(tabId, true),
  },
  unmute: {
    failure: 'This tab could not be unmuted.',
    icon: 'sound',
    keywords: [],
    label: 'Unmute music',
    run: (handlers, tabId) => handlers.setMuted(tabId, false),
  },
  focus: {
    failure: 'The audio tab could not be focused.',
    icon: 'music',
    keywords: ['go to', 'show'],
    label: 'Switch to music',
    run: (handlers, tabId) => handlers.focus(tabId),
  },
} satisfies Record<string, MediaCommandDefinition>;

type MediaCommandKind = keyof typeof definitions;

const MEDIA_COMMAND_PREFIX = 'media:';

function definitionFor(id: string): MediaCommandDefinition | undefined {
  if (!id.startsWith(MEDIA_COMMAND_PREFIX)) return undefined;
  const kind = id.slice(MEDIA_COMMAND_PREFIX.length);
  return Object.hasOwn(definitions, kind) ? definitions[kind as MediaCommandKind] : undefined;
}

/**
 * Search's music commands for a window. They do what Now Playing's buttons do
 * to the tab it shows, so play and pause appear only where Now Playing shows
 * them and muting stands in otherwise, plus switching to that tab when it is
 * not already in front. Ids name the choice rather than the tab, so Search
 * learns a pick across tabs.
 */
export function mediaCommands(context: MediaCommandContext): SearchCommand[] {
  const tab = nowPlayingTab(
    context.tabs,
    context.windowId ?? null,
    context.mediaTarget,
    context.mediaRetainedTabId,
  );
  const tabId = tab?.id;
  if (!tab || tabId === undefined) return [];
  const target = context.mediaTarget?.tabId === tabId ? context.mediaTarget : undefined;
  const kinds: MediaCommandKind[] = [];
  // Now Playing dims its controls while a silent tab has no paused player.
  if (tab.audible || target?.state === 'paused') {
    if (context.mediaControlAvailable && target) {
      kinds.push(target.state === 'playing' ? 'pause' : 'play');
    } else {
      kinds.push(tab.mutedInfo?.muted ? 'unmute' : 'mute');
    }
  }
  if (tabId !== context.activeTabId) kinds.push('focus');
  const detail = tabDisplayTitle(tab, 'Playing audio');
  return kinds.map((kind) => {
    const { icon, keywords, label } = definitions[kind];
    return {
      detail,
      icon,
      id: `${MEDIA_COMMAND_PREFIX}${kind}`,
      keywords: [...MEDIA_KEYWORDS, ...keywords],
      label,
      tabId,
    };
  });
}

/** A window's music commands at one committed revision, as its sidebar would build them. */
export function windowMediaCommands(
  snapshot: HyperModelSnapshot,
  windowId: number,
): SearchCommand[] {
  const tabs = snapshot.browser.tabs.filter((tab) => tab.windowId === windowId);
  return mediaCommands({
    activeTabId: tabs.find((tab) => tab.active)?.id,
    mediaControlAvailable: snapshot.runtime.mediaControlAvailable,
    mediaRetainedTabId: snapshot.runtime.mediaRetainedTabIds[windowId],
    mediaTarget: mediaTargetForWindow(
      tabs,
      windowId,
      snapshot.runtime.mediaStates,
      snapshot.runtime.mediaRetainedTabIds,
    ),
    tabs,
    windowId,
  });
}

/** Makes a music command runnable here, or undefined when the command is not one. */
export function mediaCommandAction(
  command: SearchCommand,
  handlers: MediaCommandHandlers,
): CommandAction | undefined {
  const definition = definitionFor(command.id);
  const { tabId } = command;
  if (!definition || tabId === undefined) return undefined;
  return {
    ...command,
    run: async () => {
      try {
        await definition.run(handlers, tabId);
      } catch (error) {
        handlers.onError(error instanceof Error && error.message ? error.message : definition.failure);
      }
    },
  };
}

export function mediaCommandActions(
  context: MediaCommandContext,
  handlers: MediaCommandHandlers,
): CommandAction[] {
  return mediaCommands(context).flatMap((command) => mediaCommandAction(command, handlers) ?? []);
}
