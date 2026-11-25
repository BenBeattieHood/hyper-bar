import type { BrowserTab, Space } from '../../lib/bookmarks';
import type { CommandAction, CommandIcon } from '../../lib/commandBar';
import { mediaCommandActions } from '../../lib/mediaCommands';
import { shortcutLabel, spaceShortcutId, SHORTCUTS, type ShortcutId } from '../../lib/shortcuts';
import type { useBrowserState } from '../hooks/useBrowserState';
import type { SidebarShortcutActions } from '../hooks/useSidebarShortcuts';

type CommandBrowserState = Pick<
  ReturnType<typeof useBrowserState>,
  | 'currentWindowId'
  | 'favouritesFolderId'
  | 'mediaControlAvailable'
  | 'mediaRetainedTabId'
  | 'mediaTarget'
  | 'setTabMediaPlayback'
  | 'setTabMuted'
  | 'tabs'
>;

/** A Search row that runs a sidebar shortcut and shows its key. */
function shortcutCommand(
  actions: SidebarShortcutActions,
  id: ShortcutId,
  label: string,
  icon: CommandIcon,
  keywords: string[],
): CommandAction[] {
  const run = actions[id];
  const commandId = SHORTCUTS[id].command;
  return run && commandId
    ? [{ id: commandId, label, detail: 'Hyper', icon, shortcut: shortcutLabel(id), keywords, run }]
    : [];
}

export function hyperCommandActions({
  actions,
  activeSpace,
  activeWindowTab,
  browserState,
  focusAudibleTab,
  selectSpace,
  showNotice,
  spaces,
}: {
  /** The sidebar shortcuts, so a Search row and its key run the same thing. */
  actions: SidebarShortcutActions;
  activeSpace: Space;
  activeWindowTab: BrowserTab | undefined;
  browserState: CommandBrowserState;
  focusAudibleTab(tab: BrowserTab): Promise<void>;
  selectSpace(spaceId: string): Promise<boolean>;
  showNotice(message: string): void;
  spaces: Space[];
}): CommandAction[] {
  const { favouritesFolderId } = browserState;
  const command = (id: ShortcutId, label: string, icon: CommandIcon, keywords: string[]) =>
    shortcutCommand(actions, id, label, icon, keywords);
  return [
    ...command('settings', 'Open Hyper settings', 'settings', ['preferences']),
    ...command('showTabs', 'Show tabs', 'tab', ['tab list', 'open tabs']),
    ...command('showBookmarks', 'Show bookmarks', 'bookmark', ['bookmark list', 'space bookmarks']),
    ...(favouritesFolderId
      ? command('addFavourite', 'Add current page to favourites', 'bookmark', ['pin page', 'favourite page'])
      : []),
    ...command('addBookmark', `Add current page to ${activeSpace.title}`, 'bookmark', ['bookmark page', 'save page']),
    ...command('createTabFolder', 'Create tab folder', 'tab', ['new tab folder', 'group tabs']),
    ...command('createBookmarkFolder', 'Create bookmark folder', 'bookmark', ['new bookmark folder', 'new folder']),
    ...command('globalBookmarks', 'Show or hide global bookmarks', 'bookmark', ['global bookmarks', 'shared bookmarks']),
    ...command('newSpace', 'Create new space', 'space', ['add space']),
    ...(spaces.length > 1 ? [
      ...command('previousSpace', 'Switch to previous space', 'space', ['space left']),
      ...command('nextSpace', 'Switch to next space', 'space', ['space right']),
    ] : []),
    ...spaces.map((space, index) => {
      const shortcutId = spaceShortcutId(index);
      return {
        id: `space:${space.id}`,
        label: `Switch to ${space.title}`,
        detail: space.id === activeSpace.id ? 'Current space' : 'Hyper space',
        icon: 'space' as const,
        keywords: [space.title],
        ...(shortcutId && actions[shortcutId] ? { shortcut: shortcutLabel(shortcutId) } : {}),
        run: async () => {
          await selectSpace(space.id);
        },
      };
    }),
    ...mediaCommandActions({
      activeTabId: activeWindowTab?.id,
      mediaControlAvailable: browserState.mediaControlAvailable,
      mediaRetainedTabId: browserState.mediaRetainedTabId,
      mediaTarget: browserState.mediaTarget,
      tabs: browserState.tabs,
      windowId: browserState.currentWindowId,
    }, {
      focus: async (tabId) => {
        const tab = browserState.tabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error('The audio tab has closed.');
        await focusAudibleTab(tab);
      },
      onError: showNotice,
      setMuted: browserState.setTabMuted,
      setPlayback: browserState.setTabMediaPlayback,
    }),
  ];
}
