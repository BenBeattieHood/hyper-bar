import type { HyperSidebarProjection } from '../../lib/modelPort';
import {
  noBrowserCommandCapabilities,
  type BrowserCommandCapabilities,
} from '../../lib/browserCommandCapabilities';
import { shownSpaces, type Space } from '../../lib/bookmarks';
import type { TabMediaState } from '../../lib/mediaState';

export interface NewTabData {
  activeSpaceId: string;
  commandCapabilities: BrowserCommandCapabilities;
  currentTab?: Browser.tabs.Tab;
  mediaControlAvailable: boolean;
  mediaRetainedTabId?: number;
  mediaTarget?: TabMediaState;
  revision: number;
  spaces: Space[];
  tabs: Browser.tabs.Tab[];
  windowId?: number;
}

export const EMPTY_NEW_TAB_DATA: NewTabData = {
  activeSpaceId: '',
  commandCapabilities: noBrowserCommandCapabilities,
  mediaControlAvailable: false,
  revision: 0,
  spaces: [],
  tabs: [],
};

/**
 * The new tab page reads the same revision the sidebar does. It holds no
 * Search records, which the background serves separately from that same
 * revision, so this projection contains only the data New Tab renders or
 * builds its own commands from.
 */
type NewTabProjection = {
  commandCapabilities?: HyperSidebarProjection['commandCapabilities'];
  hyper: Pick<HyperSidebarProjection['hyper'], 'spaces'>;
  revision: number;
  window: Pick<
    HyperSidebarProjection['window'],
    | 'activeSpaceId'
    | 'mediaControlAvailable'
    | 'mediaRetainedTabId'
    | 'mediaTarget'
    | 'tabOwnerships'
    | 'tabs'
    | 'windowId'
  >;
};

export function projectNewTabData(
  projection: NewTabProjection,
  currentTabId: number | undefined,
): NewTabData {
  // Only a space pagination shows can be switched to.
  const spaces = shownSpaces(projection.hyper.spaces);
  const activeSpaceId = spaces.some((space) => space.id === projection.window.activeSpaceId)
    ? projection.window.activeSpaceId as string
    : spaces[0]?.id ?? '';
  const tabs = projection.window.tabs;
  return {
    activeSpaceId,
    commandCapabilities: projection.commandCapabilities ?? noBrowserCommandCapabilities,
    currentTab: currentTabId === undefined
      ? tabs.find((tab) => tab.active)
      : tabs.find((tab) => tab.id === currentTabId),
    mediaControlAvailable: projection.window.mediaControlAvailable,
    mediaRetainedTabId: projection.window.mediaRetainedTabId,
    mediaTarget: projection.window.mediaTarget,
    revision: projection.revision,
    spaces,
    tabs,
    windowId: projection.window.windowId,
  };
}
