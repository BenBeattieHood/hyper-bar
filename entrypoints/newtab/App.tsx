import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CommandBar } from '../sidepanel/components/CommandBar';
import { reportBuildMismatch } from '../sidepanel/lib/buildMismatch';
import { searchItemEntry } from '../sidepanel/lib/clipboardItems';
import { itemMenuEntries } from '../sidepanel/lib/itemActions';
import { writeClipboard } from '../sidepanel/lib/itemClipboard';
import { errorMessage } from '../sidepanel/lib/notify';
import { browserCommandActions, type BrowserCommandIntent } from '../lib/browserCommands';
import type { CommandAction, NavigationTarget } from '../lib/commandBar';
import {
  mediaCommandAction,
  mediaCommandActions,
  type MediaCommandHandlers,
} from '../lib/mediaCommands';
import type { HyperActionKind } from '../lib/modelActions';
import {
  createHyperModelClient,
  modelClientSearch,
  type HyperModelClient,
} from '../lib/modelClient';
import type { HyperSidebarProjection } from '../lib/modelPort';
import {
  closePageSearchOverlay,
  focusPageSearchOverlayMessageType,
  isPageOpenShortcut,
  newTabShownMessageType,
  pageSearchOverlayLayoutMessageType,
  pageSearchOverlayReadyMessageType,
  parseSearchOverlaySource,
} from '../lib/pageShortcut';
import type { SearchItem } from '../lib/search';
import type { SearchCommand } from '../lib/searchIndex';
import { shortcutLabel } from '../lib/shortcuts';
import { randomInspiration } from './lib/inspiration';
import { tabNavigationUnderway, underwayText } from './lib/navigationUnderway';
import { searchEngineSettings } from './lib/searchEngineSettings';
import { listen } from '../sidepanel/lib/listen';
import {
  EMPTY_NEW_TAB_DATA,
  projectNewTabData,
  type NewTabData,
} from './lib/newTabData';

async function announceNewTabShown(): Promise<void> {
  await browser.runtime.sendMessage({ type: newTabShownMessageType }).catch(() => undefined);
}

// The overlay frame is larger than what it paints, so presses elsewhere fall on the page's surround.
const OVERLAY_SURFACES = '.newtab-brand, .command-bar-input, .command-bar-results, .newtab-notice:not(:empty)';
const isOverlaySurround = (target: EventTarget) =>
  target instanceof Element && !target.closest(OVERLAY_SURFACES);

export default function App() {
  const commandInputRef = useRef<HTMLInputElement>(null);
  const surroundPressRef = useRef(false);
  const modelClientRef = useRef<HyperModelClient | undefined>(undefined);
  const search = useRef(modelClientSearch(modelClientRef)).current;
  const [searchOverlaySource] = useState(() => parseSearchOverlaySource(location.href));
  const [data, setData] = useState<NewTabData>(EMPTY_NEW_TAB_DATA);
  const [pageSearchRevision, setPageSearchRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<ReactNode>();
  const [inspiration] = useState(randomInspiration);
  // A search or address this page started, shown before the tab reports loading it.
  const [startedNavigation, setStartedNavigation] = useState<string>();
  const startedNavigationSeenRef = useRef(false);
  const tabUnderway = searchOverlaySource
    ? undefined
    : tabNavigationUnderway(data.currentTab, `${location.origin}${location.pathname}`);
  const underway = startedNavigation ?? tabUnderway;

  useEffect(() => {
    if (startedNavigation === undefined) {
      startedNavigationSeenRef.current = false;
      return;
    }
    if (tabUnderway !== undefined) {
      startedNavigationSeenRef.current = true;
      return;
    }
    // Once the tab has stopped loading without leaving, or if it never began, the field returns.
    if (startedNavigationSeenRef.current) {
      setStartedNavigation(undefined);
      return;
    }
    const timer = window.setTimeout(() => setStartedNavigation(undefined), 10_000);
    return () => window.clearTimeout(timer);
  }, [startedNavigation, tabUnderway]);

  useEffect(() => listen([window, 'pageshow', (event: PageTransitionEvent) => {
    if (event.persisted) setStartedNavigation(undefined);
  }]), []);

  useEffect(() => {
    if (!searchOverlaySource) void announceNewTabShown();
  }, [searchOverlaySource]);

  useEffect(() => {
    if (!searchOverlaySource) return;
    const frame = requestAnimationFrame(() => {
      window.parent.postMessage({ type: pageSearchOverlayReadyMessageType }, '*');
    });
    return () => cancelAnimationFrame(frame);
  }, [searchOverlaySource]);

  useEffect(() => {
    if (!searchOverlaySource) return;
    const commandBar = document.querySelector<HTMLElement>('.command-bar-newtab');
    if (!commandBar) return;
    const publishLayout = () => window.parent.postMessage({
      type: pageSearchOverlayLayoutMessageType,
      expanded: commandBar.dataset.resultsVisible === 'true',
    }, '*');
    const observer = new MutationObserver(publishLayout);
    observer.observe(commandBar, {
      attributes: true,
      attributeFilter: ['data-results-visible'],
    });
    publishLayout();
    return () => observer.disconnect();
  }, [searchOverlaySource]);

  useEffect(() => {
    if (!searchOverlaySource) return;
    const focusSearch = (event: MessageEvent) => {
      if (
        event.source !== window.parent ||
        !event.data ||
        typeof event.data !== 'object' ||
        !('type' in event.data) ||
        event.data.type !== focusPageSearchOverlayMessageType
      ) return;
      commandInputRef.current?.focus({ preventScroll: true });
    };
    return listen([window, 'message', focusSearch]);
  }, [searchOverlaySource]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && searchOverlaySource) {
        // Escape closes a result's menu first, and the overlay only after.
        if (event.target instanceof Element && event.target.closest('.context-menu')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        closePageSearchOverlay();
        return;
      }
      if (!isPageOpenShortcut(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      commandInputRef.current?.focus({ preventScroll: true });
      void announceNewTabShown();
    };
    return listen([window, 'keydown', handleKeyDown, true]);
  }, [searchOverlaySource]);

  useEffect(() => {
    let cancelled = false;
    let client: HyperModelClient | undefined;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      if (searchOverlaySource && searchOverlaySource.windowId === undefined) {
        setNotice('Hyper could not load this new tab.');
        setLoading(false);
        return;
      }
      client = searchOverlaySource
        ? createHyperModelClient({
          onBuildMismatch: reportBuildMismatch,
          onCommandStatuses: (_statuses, revision) => {
            setPageSearchRevision(revision);
            setLoading(false);
          },
          role: 'page-search',
          windowId: searchOverlaySource.windowId,
        })
        : createHyperModelClient<HyperSidebarProjection>({
          onBuildMismatch: reportBuildMismatch,
          onProjection: (projection) => {
            setData(projectNewTabData(projection, undefined));
            setLoading(false);
          },
          role: 'newtab',
        });
      modelClientRef.current = client;
    }).catch((error) => {
      if (cancelled) return;
      setNotice(errorMessage(error, 'Hyper could not load this new tab.'));
      setLoading(false);
    });
    return () => {
      cancelled = true;
      client?.dispose();
      if (modelClientRef.current === client) modelClientRef.current = undefined;
    };
  }, [searchOverlaySource]);

  const modelRevision = searchOverlaySource ? pageSearchRevision : data.revision;
  const activeSpaceId = searchOverlaySource ? '' : data.activeSpaceId;

  const reportError = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => current === message ? undefined : current), 2600);
  };
  const reportFailure = (fallback: string) => (error: unknown) => reportError(errorMessage(error, fallback));
  // Stays until replaced: the user needs time to follow the link.
  const showSearchEngineNotice = () => {
    const settings = searchEngineSettings(navigator.userAgent);
    setNotice(
      <>
        {settings.browser} has no default search engine — choose one in{' '}
        <a
          href={settings.url}
          onClick={(event) => {
            event.preventDefault();
            void submitIntent('navigateTab', { kind: 'url', url: settings.url })
              .catch(reportFailure('Settings could not be opened.'));
          }}
        >
          Settings
        </a>
      </>,
    );
  };
  const closeSearchOverlay = () => {
    if (searchOverlaySource) closePageSearchOverlay();
  };
  const connectedClient = () => {
    const client = modelClientRef.current;
    if (!client) throw new Error('Hyper is still connecting to the browser model.');
    return client;
  };
  const submitIntent = async (kind: HyperActionKind, payload: unknown) => {
    const outcome = await connectedClient().submitIntent(kind, payload);
    if (outcome.status !== 'accepted') throw new Error('Hyper could not accept that action.');
  };
  const submitIntentSettled = async (kind: HyperActionKind, payload: unknown, failure: string) => {
    const outcome = await connectedClient().submitSettledIntent(kind, payload);
    if (!outcome.succeeded) throw new Error(failure);
  };
  const submitSettledBrowserCommand = (intent: BrowserCommandIntent): Promise<void> =>
    submitIntentSettled(intent.kind, intent.payload, 'That browser action could not be completed.');
  const recordSearchSelection = (query: string, resultId: string): Promise<void> =>
    submitIntentSettled('recordSearchSelection', { query, resultId }, 'Search selection could not be recorded.');
  const forgetSearchSelection = (resultId: string): Promise<void> =>
    submitIntentSettled('forgetSearchSelection', { resultId }, 'Search selection could not be forgotten.');
  // A search overlay closes once the page it asked for is showing.
  const submitIntentAndClose = async (kind: HyperActionKind, payload: unknown) => {
    await submitIntent(kind, payload);
    closeSearchOverlay();
  };
  const navigate = async (target: NavigationTarget | { url: string }, { newTab = false } = {}) => {
    const url = 'url' in target ? target.url : undefined;
    const query = 'query' in target ? target.query : '';
    // A new tab leaves this page where it is, so only a navigation here shows as underway.
    if (!searchOverlaySource && !newTab) setStartedNavigation(url === undefined ? query : underwayText(url));
    try {
      if (url !== undefined) {
        await submitIntentAndClose('navigateTab', { kind: 'url', newTab, url });
        return;
      }
      const outcome = await connectedClient().submitSettledIntent('navigateTab', { kind: 'search', newTab, query });
      if (outcome.failure === 'unsupported') {
        setStartedNavigation(undefined);
        return showSearchEngineNotice();
      }
      if (!outcome.succeeded) throw new Error('That search could not be run.');
      closeSearchOverlay();
    } catch (error) {
      setStartedNavigation(undefined);
      throw error;
    }
  };
  const activateItem = async (
    item: SearchItem,
    destinationSpaceId?: string,
    options: { newTab?: boolean } = {},
  ) => {
    if (options.newTab && item.url) return submitIntentAndClose('navigateTab', { kind: 'url', newTab: true, url: item.url });
    const destination = destinationSpaceId
      ? item.openSpaces?.find((space) => space.id === destinationSpaceId)
      : undefined;
    const targetTabId = destinationSpaceId ? destination?.tabId : item.tabId;
    if (item.kind === 'tab' && targetTabId !== undefined) {
      // The background closes this new tab page once the open tab is showing.
      return submitIntentAndClose('activateTab', { tabId: targetTabId });
    }
    if (item.url) await navigate({ url: item.url });
  };
  // Closing a result's page in another space leaves this page, and any overlay, open.
  const closeInSpace = (tabId: number, spaceId: string) => void submitIntentSettled(
    'closeTabs',
    { condition: 'page-in-space', source: { kind: 'tab', tabId }, spaceId },
    'Those tabs could not be closed.',
  ).catch(reportFailure('Those tabs could not be closed.'));

  const runtimeBrowser = browser as unknown as {
    sidePanel?: { open?: (options: { windowId: number }) => Promise<void> };
    sidebarAction?: { open?: () => Promise<void> };
  };
  const switchSpace = async (spaceId: string) => {
    await submitIntent('selectSpace', { spaceId }).catch(reportFailure('That space could not be opened.'));
  };
  const mediaHandlers: MediaCommandHandlers = {
    // A new tab page that switches to the music closes, as it does for a tab result.
    focus: (tabId) => submitIntent('activateTab', { tabId }),
    onError: reportError,
    setMuted: (tabId, muted) => submitIntentSettled(
      'setTabMuted',
      { muted, tabId },
      `This tab could not be ${muted ? 'muted' : 'unmuted'}.`,
    ),
    setPlayback: (tabId, state) =>
      submitIntentSettled('setTabMediaPlayback', { state, tabId }, 'Playback could not be changed.'),
  };
  const resolveCommand = (command: SearchCommand): CommandAction | undefined =>
    command.id.startsWith('space:')
      ? { ...command, run: () => switchSpace(command.id.slice('space:'.length)) }
      : mediaCommandAction(command, mediaHandlers);
  const commands: CommandAction[] = [
    ...(runtimeBrowser.sidePanel?.open || runtimeBrowser.sidebarAction?.open ? [{
      id: 'open-hyper',
      label: 'Open Hyper sidebar',
      detail: 'Hyper',
      icon: 'space' as const,
      keywords: ['show sidebar'],
      shortcut: shortcutLabel('openHyper'),
      run: async () => {
        try {
          if (runtimeBrowser.sidePanel?.open && data.currentTab?.windowId !== undefined) {
            await runtimeBrowser.sidePanel.open({ windowId: data.currentTab.windowId });
          } else if (runtimeBrowser.sidebarAction?.open) {
            await runtimeBrowser.sidebarAction.open();
          }
          closeSearchOverlay();
        } catch (error) {
          reportFailure('The sidebar could not be opened.')(error);
        }
      },
    }] : []),
    ...(!searchOverlaySource ? data.spaces.map((space) => ({
      id: `space:${space.id}`,
      label: `Switch to ${space.title}`,
      detail: space.id === data.activeSpaceId ? 'Current space' : 'Hyper space',
      icon: 'space' as const,
      keywords: [space.title],
      run: () => switchSpace(space.id),
    })) : []),
    ...(!searchOverlaySource ? mediaCommandActions({
      activeTabId: data.currentTab?.id,
      mediaControlAvailable: data.mediaControlAvailable,
      mediaRetainedTabId: data.mediaRetainedTabId,
      mediaTarget: data.mediaTarget,
      tabs: data.tabs,
      windowId: data.windowId,
    }, mediaHandlers) : []),
    ...(!searchOverlaySource ? browserCommandActions({
      capabilities: data.commandCapabilities,
      currentTab: data.currentTab,
      onError: reportError,
      submitIntent: submitSettledBrowserCommand,
      tabs: data.tabs,
    }) : []),
  ];

  return (
    <main
      className={`newtab-shell${searchOverlaySource ? ' is-search-overlay' : ''}`}
      onPointerDown={(event) => {
        // An open item menu takes the first outside press, like Escape.
        surroundPressRef.current = Boolean(searchOverlaySource) &&
          isOverlaySurround(event.target) &&
          !document.querySelector('.context-menu');
      }}
      onClick={(event) => {
        const surroundPress = surroundPressRef.current;
        surroundPressRef.current = false;
        if (surroundPress && isOverlaySurround(event.target)) {
          closeSearchOverlay();
          return;
        }
        if (
          event.target instanceof Element &&
          event.target.closest('a, button, input, [contenteditable="true"]')
        ) return;
        commandInputRef.current?.focus({ preventScroll: true });
      }}
    >
      <div className="newtab-command">
        <div className="newtab-brand" role="img" aria-label="Hyper" />
        <CommandBar
          activeSpaceId={activeSpaceId}
          commands={commands}
          inputRef={commandInputRef}
          historyLoading={loading}
          modelRevision={modelRevision}
          search={search}
          showFolders={false}
          underway={underway}
          variant="newtab"
          onClose={searchOverlaySource ? closeSearchOverlay : undefined}
          onCloseInSpace={closeInSpace}
          onActivateItem={(item, destinationSpaceId, options) => void activateItem(item, destinationSpaceId, options)
            .catch(reportFailure('That page could not be opened.'))}
          onDeleteHistory={async (url) => {
            try {
              await submitIntent('deleteHistory', { url });
            } catch (error) {
              reportFailure('That history entry could not be deleted.')(error);
              throw error;
            }
          }}
          onForgetSearchSelection={forgetSearchSelection}
          onRecordSearchSelection={recordSearchSelection}
          itemMenu={(item) => item.url ? itemMenuEntries({
            count: 1,
            copy: () => void writeClipboard({ hyper: 1, operation: 'copy', items: [searchItemEntry(item)] })
              .catch(() => reportError('That could not be copied.')),
          }) : []}
          resolveCommand={searchOverlaySource ? resolveCommand : undefined}
          onNavigate={(target, options) => void navigate(target, options)
            .catch(reportFailure('That address could not be opened.'))}
        />
        <p className="newtab-inspiration">{inspiration}</p>
        <div className="newtab-notice" role="status" aria-live="polite">
          {notice}
        </div>
      </div>
    </main>
  );
}