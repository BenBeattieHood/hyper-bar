import { Archive, ArchiveRestore, CopyPlus, Pencil, RefreshCw, SquareStack, Trash2, X } from 'lucide-react';
import type { MouseEvent } from 'react';
import type { BookmarkNode, BrowserTab, Space } from '../../lib/bookmarks';
import { isBlankTabPage, isTabUnloaded } from '../../lib/tabs';
import { menuGroups, type ContextMenuEntry } from '../components/ContextMenu';
import type { useBrowserState } from '../hooks/useBrowserState';
import { closeTabsLabel, countedTabsLabel, type ItemActions } from './itemActions';
import { errorMessage, type Notify } from './notify';
import { tabUrl } from '../../lib/urlIdentity';

type BrowserStateApi = ReturnType<typeof useBrowserState>;

/** How many of this window's tabs in a space its menu acts on, counted as the background chooses them. */
export interface SpaceTabCounts {
  /** Pages closing the space's tabs closes; a blank page holds nothing to close. */
  closable: number;
  /** Those holding their page, which reloading reloads. */
  reloadable: number;
}

export function spaceTabCounts(
  tabs: readonly BrowserTab[],
  { newTabUrl, spaceId, tabSpaceIds, windowId }: {
    newTabUrl: string;
    spaceId: string;
    tabSpaceIds: Readonly<Record<number, string>>;
    windowId: number | null;
  },
): SpaceTabCounts {
  const pages = tabs.filter((tab) =>
    tab.id !== undefined &&
    tab.windowId === windowId &&
    !tab.pinned &&
    tabSpaceIds[tab.id] === spaceId &&
    !isBlankTabPage(tabUrl(tab), newTabUrl));
  return { closable: pages.length, reloadable: pages.filter((tab) => !isTabUnloaded(tab)).length };
}

export interface SpaceMenuActions {
  /** Absent for the only unarchived space, which must stay shown. */
  archive?: () => void;
  close(): void;
  /** Absent for the only space, which cannot be deleted. */
  delete?: () => void;
  duplicate(withTabs: boolean): void;
  reload(): void;
  rename(): void;
  /** Present only for an archived space, whose menu offers nothing else but renaming and deleting. */
  unarchive?: () => void;
}

const reloadTabsLabel = countedTabsLabel('Reload', 'Reload tab');

/** A space's menu, laid out as a row's is, with the actions on its tabs offered only when it has some. */
export function spaceMenuEntries(counts: SpaceTabCounts, actions: SpaceMenuActions): ContextMenuEntry[] {
  const deletion = actions.delete
    ? [{ danger: true, icon: Trash2, id: 'delete', label: 'Delete space', onSelect: actions.delete }]
    : [];
  if (actions.unarchive) {
    return menuGroups([
      [
        { icon: ArchiveRestore, id: 'unarchive', label: 'Unarchive', onSelect: actions.unarchive },
        { icon: Pencil, id: 'rename', label: 'Rename', onSelect: actions.rename },
      ],
      deletion,
    ]);
  }
  return menuGroups([
    [{ icon: Pencil, id: 'rename', label: 'Rename', onSelect: actions.rename }],
    [
      { icon: SquareStack, id: 'duplicate', label: 'Duplicate', onSelect: () => actions.duplicate(false) },
      ...(counts.closable > 0 ? [{
        icon: CopyPlus,
        id: 'duplicate-with-tabs',
        label: 'Duplicate with tabs',
        onSelect: () => actions.duplicate(true),
      }] : []),
    ],
    counts.reloadable > 0
      ? [{ icon: RefreshCw, id: 'reload', label: reloadTabsLabel(counts.reloadable), onSelect: actions.reload }]
      : [],
    [
      ...(counts.closable > 0
        ? [{ icon: X, id: 'close', label: closeTabsLabel(counts.closable), onSelect: actions.close }]
        : []),
      ...(actions.archive ? [{ icon: Archive, id: 'archive', label: 'Archive', onSelect: actions.archive }] : []),
      ...deletion,
    ],
  ]);
}

export interface SpaceMenuDependencies {
  browserState: Pick<
    BrowserStateApi,
    'closeSpaceTabs' | 'currentWindowId' | 'reloadSpaceTabs' | 'setSpaceArchived' | 'tabSpaceIds' | 'tabs'
  >;
  /** Copies the space and asks for the copy's name, handing focus back to `returnFocus` after. */
  duplicateSpace(spaceId: string, withTabs: boolean, returnFocus: HTMLElement): void;
  extensionOrigin: string;
  nodeMap: ReadonlyMap<string, BookmarkNode>;
  openMenu: ItemActions['openMenu'];
  renameSpace(spaceId: string, returnFocus: HTMLElement): void;
  /** Deletes as dropping the space on the bin does, asking first when it holds bookmarks. */
  requestDeletion(node: BookmarkNode): Promise<void>;
  showNotice: Notify;
  /** The spaces pagination shows; archived spaces are not among them. */
  spaces: readonly Space[];
}

/** Opens a space's menu from its dot; a dialog it opens hands focus back to the dot, not the menu. */
export function createSpaceMenuOpener(dependencies: SpaceMenuDependencies) {
  return (event: MouseEvent<HTMLElement>, space: Space) => {
    const { browserState, showNotice } = dependencies;
    const dot = event.currentTarget;
    const node = dependencies.nodeMap.get(space.id);
    const reportFailure = (fallback: string) => (error: unknown) => showNotice(errorMessage(error, fallback));
    const counts = spaceTabCounts(browserState.tabs, {
      newTabUrl: `${dependencies.extensionOrigin}newtab.html`,
      spaceId: space.id,
      tabSpaceIds: browserState.tabSpaceIds,
      windowId: browserState.currentWindowId,
    });
    dependencies.openMenu(event, `Actions for ${space.title}`, spaceMenuEntries(counts, {
      close: () => void browserState.closeSpaceTabs(space.id)
        .catch(reportFailure('These tabs could not be closed')),
      ...(dependencies.spaces.length > 1 ? {
        archive: () => void browserState.setSpaceArchived(space.id, true)
          .catch(reportFailure('That space could not be archived')),
      } : {}),
      ...(node && (space.archived || dependencies.spaces.length > 1) ? {
        delete: () => void dependencies.requestDeletion(node)
          .catch(reportFailure('That space could not be deleted')),
      } : {}),
      duplicate: (withTabs) => dependencies.duplicateSpace(space.id, withTabs, dot),
      reload: () => void browserState.reloadSpaceTabs(space.id)
        .catch(reportFailure('These tabs could not be reloaded')),
      rename: () => dependencies.renameSpace(space.id, dot),
      ...(space.archived ? {
        unarchive: () => void browserState.setSpaceArchived(space.id, false)
          .catch(reportFailure('That space could not be unarchived')),
      } : {}),
    }));
  };
}
