import { useMemo, useState } from 'react';
import type { BrowserTab } from '../../lib/bookmarks';
import { mediaControlTabs, type TabMediaState } from '../../lib/mediaState';

interface UseMediaControlsOptions {
  currentWindowId: number | null;
  media: {
    mediaControlAvailable: boolean;
    mediaRetainedTabId?: number;
    mediaTarget?: TabMediaState;
    setTabMediaPlayback: (tabId: number, state: 'paused' | 'playing') => Promise<void>;
  };
  tabs: BrowserTab[];
}

/**
 * The background owns media observation and the current target. The sidebar
 * merely chooses how that committed state is presented and submits playback
 * changes as explicit intents.
 */
export function useMediaControls({
  currentWindowId,
  media,
  tabs,
}: UseMediaControlsOptions) {
  const {
    mediaControlAvailable,
    mediaRetainedTabId,
    mediaTarget,
    setTabMediaPlayback,
  } = media;
  const [isUpdating, setIsUpdating] = useState(false);
  const displayTabs = useMemo(
    () => mediaControlTabs(tabs, currentWindowId, mediaTarget, mediaRetainedTabId),
    [currentWindowId, mediaRetainedTabId, mediaTarget, tabs],
  );
  const selectedTab = displayTabs.find((tab) => tab.id !== undefined);
  const targetForSelected = mediaTarget && mediaTarget.tabId === selectedTab?.id
    ? mediaTarget
    : undefined;
  // A retained tab that has fallen silent without a committed paused target is
  // still shown, but dimmed and uncontrollable, until the background recaptures
  // its media or releases the slot.
  const isUnavailable = selectedTab !== undefined &&
    !selectedTab.audible &&
    targetForSelected?.state !== 'paused';

  const togglePlayback = async () => {
    if (!mediaTarget || isUpdating || !mediaControlAvailable) return;
    setIsUpdating(true);
    try {
      await setTabMediaPlayback(
        mediaTarget.tabId,
        mediaTarget.state === 'playing' ? 'paused' : 'playing',
      );
    } finally {
      setIsUpdating(false);
    }
  };

  return {
    controlledTabId: mediaTarget?.tabId,
    displayTabs,
    isUnavailable,
    isUpdating,
    playbackAccessEnabled: mediaControlAvailable,
    playbackState: targetForSelected?.state,
    togglePlayback,
  };
}