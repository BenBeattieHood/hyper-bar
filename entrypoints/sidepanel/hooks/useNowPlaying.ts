import { useEffect, useMemo, useRef, useState } from 'react';
import type { BrowserTab } from '../../lib/bookmarks';
import type { FaviconAudioState } from '../components/Favicon';
import { errorMessage, type Notify } from '../lib/notify';
import type { useBrowserState } from './useBrowserState';
import { useMediaControls } from './useMediaControls';

type BrowserStateApi = ReturnType<typeof useBrowserState>;

export function useNowPlaying({
  activeWindowTab,
  browserState,
  clearSelectedTabsAfter,
  showNotice,
}: {
  activeWindowTab: BrowserTab | undefined;
  browserState: BrowserStateApi;
  clearSelectedTabsAfter<Result>(operation: Promise<Result>): Promise<Result>;
  showNotice: Notify;
}) {
  const [mediaReturnTabId, setMediaReturnTabId] = useState<number>();
  const previousActiveTabIdRef = useRef<number | undefined>(undefined);
  const pendingMediaReturnTabIdRef = useRef<number | undefined>(undefined);
  const mediaControls = useMediaControls({
    currentWindowId: browserState.currentWindowId,
    media: browserState,
    tabs: browserState.tabs,
  });
  const audioStateByTabId = useMemo(() => Object.fromEntries(
    browserState.tabs.flatMap((tab) => {
      if (tab.id === undefined) return [];
      const controlledState = tab.id === mediaControls.controlledTabId
        ? mediaControls.playbackState
        : undefined;
      const audioState: FaviconAudioState | undefined =
        tab.mutedInfo?.muted && (tab.audible || controlledState)
          ? 'paused'
          : controlledState ?? (tab.audible ? 'playing' : undefined);
      return audioState ? [[tab.id, audioState] as const] : [];
    }),
  ), [
    browserState.tabs,
    mediaControls.controlledTabId,
    mediaControls.playbackState,
  ]);
  const selectedMediaTab = mediaControls.displayTabs.find(
    (tab) => tab.id !== undefined,
  );
  useEffect(() => {
    const activeTabId = activeWindowTab?.id;
    const mediaTabId = selectedMediaTab?.id;
    if (activeTabId === undefined) return;
    if (activeTabId === mediaTabId) {
      const returnTabId = pendingMediaReturnTabIdRef.current ??
        previousActiveTabIdRef.current;
      pendingMediaReturnTabIdRef.current = undefined;
      if (returnTabId !== undefined && returnTabId !== mediaTabId) {
        setMediaReturnTabId(returnTabId);
      }
    }
    previousActiveTabIdRef.current = activeTabId;
  }, [activeWindowTab?.id, selectedMediaTab?.id]);
  const mediaReturnTab = activeWindowTab?.id === selectedMediaTab?.id
    ? browserState.tabs.find((tab) =>
        tab.id === mediaReturnTabId &&
        tab.windowId === browserState.currentWindowId)
    : undefined;

  const focusAudibleTab = async (tab: BrowserTab) => {
    try {
      if (tab.id !== undefined && tab.id === selectedMediaTab?.id) {
        if (activeWindowTab?.id !== undefined && activeWindowTab.id !== tab.id) {
          pendingMediaReturnTabIdRef.current = activeWindowTab.id;
          setMediaReturnTabId(activeWindowTab.id);
        }
      }
      // Activating it moves the window to its space.
      await clearSelectedTabsAfter(browserState.focusTab(tab));
    } catch (error) {
      showNotice(errorMessage(error, 'The audio tab could not be focused'));
    }
  };
  const toggleAudibleTabMuted = async (tab: BrowserTab) => {
    if (tab.id === undefined) return;
    try {
      await browserState.setTabMuted(tab.id, !tab.mutedInfo?.muted);
    } catch (error) {
      showNotice(errorMessage(error, 'The audio tab could not be muted'));
    }
  };

  return {
    audioStateByTabId,
    focusAudibleTab,
    mediaControls,
    mediaReturnTab,
    toggleAudibleTabMuted,
  };
}
