import { deriveSpaces, shownSpaces } from './bookmarks';
import type { OpenTabInSpaceOptions } from './bookmarkOperations';
import type { DuplicateController } from './duplicateController';
import type { TabBookmarkLinkController } from './tabBookmarkLinkController';
import { getTabOwnership, loadTabOwnerships } from './tabOwnership';
import { closeTabOrWindow, closeTabsConcurrently, findReusableTab, tabById } from './tabs';
import { normaliseUrl, tabUrl } from './urlIdentity';
import { getWindowActiveSpaceId } from './windowState';

export interface OwnedTabOpenOptions extends OpenTabInSpaceOptions {
  splitWith?: Browser.tabs.Tab;
}

export interface OwnedTabActionDependencies {
  backingClaimedByAnotherLiveTab(
    tabId: number,
    backing: { backingId: string; backingToken?: string },
  ): Promise<boolean>;
  duplicateController: Pick<DuplicateController, 'allow'>;
  markIntentionalTab(tabId: number): void;
  persistWindowActiveSpace(windowId: number, spaceId: string): Promise<void>;
  /** Routes a tab Hyper placed itself, into the given space when it has one. */
  routeTab(tabId: number, spaceId?: string): Promise<void>;
  tabBookmarkLinks: Pick<TabBookmarkLinkController, 'claim' | 'renameTab'>;
}

/** Opens, duplicates, renames and closes tabs on Hyper's behalf, keeping each in its space. */
export function createOwnedTabActions(dependencies: OwnedTabActionDependencies) {
  const {
    duplicateController,
    markIntentionalTab,
    persistWindowActiveSpace,
    routeTab,
    tabBookmarkLinks,
  } = dependencies;

  const openTabInSpace = async (
    options: OwnedTabOpenOptions,
  ): Promise<{ tab: Browser.tabs.Tab; created: boolean }> => {
    const identity = normaliseUrl(options.url);
    if (!identity) throw new Error('This URL cannot be opened.');
    const [window, tree, storedActiveSpaceId] = await Promise.all([
      browser.windows.get(options.windowId),
      browser.bookmarks.getTree(),
      getWindowActiveSpaceId(options.windowId),
    ]);
    // An archived space opens nothing: its pages open in the window's space instead.
    const spaces = shownSpaces(deriveSpaces(tree));
    const destinationSpaceId = spaces.some(
      (space) => space.id === options.destinationSpaceId,
    )
      ? options.destinationSpaceId
      : spaces.some((space) => space.id === storedActiveSpaceId)
        ? storedActiveSpaceId
        : spaces[0]?.id;
    if (!destinationSpaceId) throw new Error('No destination space is available.');
    const context = {
      incognito: window.incognito ?? false,
      windowId: options.windowId,
    };

    if (!options.forceNew) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const tabs = await browser.tabs.query({});
        const ownerships = await loadTabOwnerships(tabs);
        const reusable = findReusableTab(
          tabs.filter((tab) => tab.id !== undefined && ownerships[tab.id]?.spaceId === destinationSpaceId),
          identity,
          context,
          options.reuse,
        );
        if (reusable?.id === undefined) break;
        const [latest, latestOwnership] = await Promise.all([
          tabById(reusable.id),
          getTabOwnership(reusable.id),
        ]);
        if (
          latest &&
          normaliseUrl(tabUrl(latest)) === identity &&
          latestOwnership?.spaceId === destinationSpaceId
        ) {
          await persistWindowActiveSpace(latest.windowId, destinationSpaceId);
          if (options.active) {
            await browser.windows.update(latest.windowId, { focused: true }).catch(() => undefined);
            await browser.tabs.update(latest.id as number, { active: true });
          }
          await tabBookmarkLinks.claim(latest.id as number);
          return { tab: latest, created: false };
        }
      }
    }

    const created = await browser.tabs.create({
      url: options.url,
      active: options.active,
      windowId: options.windowId,
      // The page takes the split's second pane, to the right of the tab it joins.
      ...(options.splitWith && { index: options.splitWith.index + 1, splitWithTabId: options.splitWith.id }),
    } as Browser.tabs.CreateProperties);
    if (created.id !== undefined) {
      markIntentionalTab(created.id);
      await persistWindowActiveSpace(created.windowId, destinationSpaceId);
      await routeTab(created.id, destinationSpaceId);
      // Hyper opened this page for the user, so a bookmark of it links without a notice.
      await tabBookmarkLinks.claim(created.id);
      if (options.forceNew) await duplicateController.allow(created.id);
    }
    return {
      tab: created.id === undefined
        ? created
        : await browser.tabs.get(created.id).catch(() => created),
      created: true,
    };
  };

  const renameOwnedTabBacking = async (
    tabId: number,
    backingId: string,
    title: string,
  ) => {
    const [tab, ownership] = await Promise.all([
      tabById(tabId),
      getTabOwnership(tabId),
    ]);
    if (!tab || ownership?.backingId !== backingId || !ownership.backingToken) {
      throw new Error('This tab no longer owns that backing.');
    }
    if (await dependencies.backingClaimedByAnotherLiveTab(tabId, {
      backingId,
      backingToken: ownership.backingToken,
    })) {
      throw new Error('Another live tab already owns that backing.');
    }
    await tabBookmarkLinks.renameTab(tab, title, {
      backingId,
      backingToken: ownership.backingToken,
      spaceId: ownership.spaceId,
      windowId: ownership.windowId,
    });
  };

  const duplicateOwnedTab = async (tabId: number) => {
    const [source, ownership] = await Promise.all([
      tabById(tabId),
      getTabOwnership(tabId),
    ]);
    if (!source) throw new Error('This tab is no longer available.');
    const duplicate = await browser.tabs.duplicate(tabId);
    if (!duplicate?.id) throw new Error('The duplicated tab is unavailable.');
    markIntentionalTab(duplicate.id);
    // The copy joins the space the original belongs to, falling back to whatever
    // the duplicate's own window has active rather than the source window's.
    const destinationSpaceId = ownership?.spaceId
      ?? await getWindowActiveSpaceId(duplicate.windowId ?? source.windowId);
    await browser.tabs.update(duplicate.id, { active: true });
    await routeTab(duplicate.id, destinationSpaceId ?? undefined);
    await duplicateController.allow(duplicate.id);
  };

  const closeTabs = async (tabIds: number[]): Promise<void> => {
    await closeTabsConcurrently(tabIds, async (tabId) => {
      const tab = await tabById(tabId);
      if (!tab) return;
      await closeTabOrWindow(tabId, tab.windowId);
    });
  };

  return { closeTabs, duplicateOwnedTab, openTabInSpace, renameOwnedTabBacking };
}
