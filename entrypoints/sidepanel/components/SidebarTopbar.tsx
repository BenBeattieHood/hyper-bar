import { Search, Settings, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import {
  type BookmarkNode,
  type Space,
} from '../../lib/bookmarks';
import type { CommandAction } from '../../lib/commandBar';
import type { SearchItem } from '../../lib/search';
import { shortcutButtonProps } from '../../lib/shortcuts';
import type { useBrowserState } from '../hooks/useBrowserState';
import type { ItemActions } from '../lib/itemActions';
import { CommandBar } from './CommandBar';
import { InlineSpaceTitle } from './InlineSpaceTitle';
import { TimedMessageNotice } from './TimedMessageNotice';
import { fadeMotion } from './WorkspaceMotion';
import { errorMessage, type Notify } from '../lib/notify';
import { expandFolders } from '../lib/folderReveal';

type BrowserStateApi = ReturnType<typeof useBrowserState>;

export function SidebarTopbar({
  activeSpace,
  browserState,
  clearSelectedTabsAfter,
  commandActions,
  itemMenu,
  nodeMap,
  reduceMotion,
  searchOpen,
  searchRef,
  searchTriggerRef,
  selectSpace,
  setCollapsedIds,
  setSearchOpen,
  setSettingsOpen,
  showGlobalBookmarks,
  settingsOpen,
  showNotice,
  spaceColours,
}: {
  activeSpace: Space;
  browserState: BrowserStateApi;
  clearSelectedTabsAfter<Result>(operation: Promise<Result>): Promise<Result>;
  commandActions: CommandAction[];
  itemMenu: ItemActions['searchMenu'];
  nodeMap: ReadonlyMap<string, BookmarkNode>;
  reduceMotion: boolean | null;
  searchOpen: boolean;
  searchRef: RefObject<HTMLInputElement | null>;
  searchTriggerRef: RefObject<HTMLButtonElement | null>;
  selectSpace(spaceId: string): Promise<boolean>;
  setCollapsedIds: Dispatch<SetStateAction<Set<string>>>;
  setSearchOpen(open: boolean): void;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  /** Global bookmark folders belong to no space, so finding one opens the global bookmarks. */
  showGlobalBookmarks(): void;
  settingsOpen: boolean;
  showNotice: Notify;
  spaceColours: Record<string, string>;
}) {
  const activateSearchItem = async (
    item: SearchItem,
    destinationSpaceId?: string,
    options: { newTab?: boolean } = {},
  ) => {
    if (!activeSpace) return;
    if (options.newTab && item.url) {
      await clearSelectedTabsAfter(browserState.openBookmark(item.url, {
        destinationSpaceId: destinationSpaceId ?? activeSpace.id,
        forceNew: true,
      }));
      return;
    }
    // A tab result is that very tab, which reopening its address could miss or duplicate.
    const tabId = item.kind !== 'tab' ? undefined : destinationSpaceId
      ? item.openSpaces?.find((space) => space.id === destinationSpaceId)?.tabId ?? item.tabId
      : item.tabId;
    const tab = browserState.tabs.find((candidate) => candidate.id !== undefined && candidate.id === tabId);
    if (tab) {
      await clearSelectedTabsAfter(browserState.focusTab(tab));
      return;
    }
    if (item.url && (destinationSpaceId || item.kind === 'tab')) {
      await clearSelectedTabsAfter(browserState.openBookmark(item.url, {
        destinationSpaceId: destinationSpaceId ?? activeSpace.id,
      }));
      return;
    }
    if (item.kind === 'folder' && item.nodeId) {
      if (item.spaceId && item.spaceId !== activeSpace.id && !await selectSpace(item.spaceId)) {
        return;
      }
      if (!item.spaceId) showGlobalBookmarks();
      if (item.nodeId === item.spaceId) {
        requestAnimationFrame(() => {
          document.querySelector<HTMLInputElement>('#space-title')?.focus();
        });
        return;
      }
      const ancestorIds = new Set<string>();
      let parentId = nodeMap.get(item.nodeId)?.parentId;
      while (parentId && parentId !== item.spaceId) {
        ancestorIds.add(parentId);
        parentId = nodeMap.get(parentId)?.parentId;
      }
      setCollapsedIds((current) => expandFolders(current, ancestorIds));
      requestAnimationFrame(() => {
        requestAnimationFrame(() => document.querySelector<HTMLElement>(
          `[data-bookmark-node-id="${CSS.escape(item.nodeId as string)}"]`,
        )?.querySelector<HTMLElement>('button.tree-item-main, button.favourite-tile')?.focus());
      });
      return;
    }
    if (item.url) {
      await clearSelectedTabsAfter(browserState.openBookmark(item.url, {
        destinationSpaceId: item.spaceId ?? activeSpace.id,
      }));
    }
  };

  return (
    <header
      className={`topbar${searchOpen ? ' has-search' : ''}`}
      aria-hidden={settingsOpen || undefined}
      inert={settingsOpen || undefined}
    >
      {!searchOpen && (
        <div className="topbar-space-title">
          <InlineSpaceTitle
            key={activeSpace.id}
            title={activeSpace.title}
            onSave={(title) => browserState.updateBookmark(activeSpace.id, title)}
            onError={showNotice}
          />
        </div>
      )}
      <div className={`topbar-actions${searchOpen ? ' is-search-open' : ''}`}>
        <TimedMessageNotice
          message={browserState.timedMessage}
          onAct={(messageId) => void browserState.actOnTimedMessage(messageId)}
          onDismiss={(messageId) => void browserState.dismissTimedMessage(messageId)}
        />
        <button
          type="button"
          className="icon-button settings-button"
          onClick={() => {
            setSearchOpen(false);
            setSettingsOpen((open) => !open);
          }}
          aria-label={settingsOpen ? 'Close settings' : 'Open settings'}
          aria-pressed={settingsOpen}
          {...shortcutButtonProps('settings')}
        >
          <Settings size={18} aria-hidden="true" />
        </button>
        <div className={`search-command-shell${searchOpen ? ' is-open' : ''}`}>
          <AnimatePresence initial={false}>
            {searchOpen && (
              <motion.div
                key="search-command-content"
                className="search-command-content"
                {...fadeMotion(reduceMotion, { duration: 0.14 })}
              >
                <CommandBar
                  activeSpaceId={activeSpace.id}
                  commands={commandActions}
                  inputRef={searchRef}
                  spaceColours={spaceColours}
                  modelRevision={browserState.modelRevision}
                  search={browserState.search}
                  onClose={(reason) => {
                    setSearchOpen(false);
                    if (reason === 'dismiss') requestAnimationFrame(() => searchTriggerRef.current?.focus());
                  }}
                  onActivateItem={(item, destinationSpaceId, options) =>
                    activateSearchItem(item, destinationSpaceId, options).catch((error: unknown) => {
                      showNotice(errorMessage(error, 'That result could not be opened'));
                    })}
                  onCloseInSpace={(tabId, spaceId) =>
                    void browserState.closeTabsInSpace({ kind: 'tab', tabId }, spaceId).catch((error: unknown) => {
                      showNotice(errorMessage(error, 'The tabs could not be closed'));
                    })}
                  itemMenu={itemMenu}
                  onDeleteHistory={async (url) => {
                    try {
                      await browserState.deleteHistory(url);
                    } catch (error) {
                      showNotice(errorMessage(error, 'That history entry could not be deleted'));
                      throw error;
                    }
                  }}
                  onForgetSearchSelection={(resultId) =>
                    browserState.forgetSearchSelection(resultId)}
                  onRecordSearchSelection={(query, resultId) =>
                    browserState.recordSearchSelection(query, resultId)}
                  onNavigate={async (target, options) => {
                    try {
                      if (target.kind === 'url') {
                        await clearSelectedTabsAfter(browserState.openBookmark(target.url, {
                          destinationSpaceId: activeSpace.id,
                          forceNew: options?.newTab,
                        }));
                        return;
                      }
                      await clearSelectedTabsAfter(browserState.searchInNewTab(target.query));
                    } catch (error) {
                      showNotice(errorMessage(error, 'That search could not be opened'));
                    }
                  }}
                />
              </motion.div>
            )}
          </AnimatePresence>
          <button
            ref={searchTriggerRef}
            type="button"
            className="search-command-action"
            onClick={() => {
              setSettingsOpen(false);
              if (searchOpen) {
                setSearchOpen(false);
                requestAnimationFrame(() => searchTriggerRef.current?.focus());
              } else {
                setSearchOpen(true);
              }
            }}
            aria-label={searchOpen ? 'Close command bar' : 'Search tabs and history'}
            aria-expanded={searchOpen}
            {...(searchOpen ? { title: 'Close' } : shortcutButtonProps('search'))}
          >
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={searchOpen ? 'close' : 'search'}
                {...fadeMotion(reduceMotion, { duration: 0.14 })}
              >
                {searchOpen
                  ? <X size={15} aria-hidden="true" />
                  : <Search size={18} aria-hidden="true" />}
              </motion.span>
            </AnimatePresence>
          </button>
        </div>
      </div>
    </header>
  );
}
