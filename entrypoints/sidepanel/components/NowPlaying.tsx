import { useDraggable } from '@dnd-kit/core';
import { ArrowLeft, Volume2, VolumeX } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { bookmarkableTabUrl, type BrowserTab } from '../../lib/bookmarks';
import type { MediaPlaybackState } from '../../lib/mediaControl';
import { useItemGesture } from '../lib/itemGesture';
import { tabDisplayTitle, tabDisplayUrl } from '../../lib/tabs';
import { Favicon } from './Favicon';

interface NowPlayingProps {
  tabs: BrowserTab[];
  returnTab?: BrowserTab;
  extensionOrigin: string;
  dropDisabled?: boolean;
  interactionDisabled?: boolean;
  mediaUnavailable?: boolean;
  playbackAccessEnabled: boolean;
  playbackState?: MediaPlaybackState;
  playbackUpdating?: boolean;
  onFocus: (tab: BrowserTab) => void;
  onTogglePlayback: () => void;
  onToggleMuted: (tab: BrowserTab) => void;
}

const playIconPath = 'M5 3 L5 9 L14 9 L5 3 Z M5 9 L5 15 L14 9 L5 9 Z';
const pauseIconPath = 'M4 3 L4 15 L8 15 L8 3 Z M10 3 L10 15 L14 15 L14 3 Z';

function PlaybackMorphIcon({ state }: { state: MediaPlaybackState }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.svg
      className="now-playing-playback-icon"
      data-playback-icon="true"
      data-playback-state={state}
      viewBox="0 0 18 18"
      aria-hidden="true"
    >
      <motion.path
        initial={false}
        animate={{ d: state === 'playing' ? pauseIconPath : playIconPath }}
        transition={reduceMotion
          ? { duration: 0 }
          : { duration: 0.32, ease: [0.4, 0, 0.2, 1] }}
      />
    </motion.svg>
  );
}

export function NowPlaying({
  tabs,
  returnTab,
  extensionOrigin,
  dropDisabled,
  interactionDisabled,
  mediaUnavailable,
  playbackAccessEnabled,
  playbackState,
  playbackUpdating,
  onFocus,
  onTogglePlayback,
  onToggleMuted,
}: NowPlayingProps) {
  const selectedTab = tabs.find((tab) => tab.id !== undefined);
  const gesture = useItemGesture();
  const mediaTitle = selectedTab
    ? tabDisplayTitle(selectedTab, 'Playing audio')
    : 'Playing audio';
  const showingReturnTab = returnTab?.id !== undefined && returnTab.id !== selectedTab?.id;
  const buttonTab = showingReturnTab ? returnTab : selectedTab;
  const buttonTitle = buttonTab
    ? tabDisplayTitle(buttonTab, showingReturnTab ? 'Previous tab' : 'Playing audio')
    : mediaTitle;
  const mediaUrl = selectedTab ? tabDisplayUrl(selectedTab) : '';
  const draggable = useDraggable({
    id: `now-playing-tab:${buttonTab?.id ?? 'none'}`,
    disabled: dropDisabled || interactionDisabled || buttonTab?.id === undefined,
    data: buttonTab?.id === undefined ? undefined : {
      kind: 'tab',
      tabId: buttonTab.id,
      title: buttonTitle,
      windowId: buttonTab.windowId,
      index: buttonTab.index,
      bookmarkable: Boolean(bookmarkableTabUrl(buttonTab, extensionOrigin)),
    },
  });

  if (!selectedTab) return null;
  const showPlaybackControl = playbackAccessEnabled && playbackState !== undefined;
  const showMuteControl = !showPlaybackControl;
  const hasControl = showPlaybackControl || showMuteControl;

  return (
    <section
      className={`now-playing${hasControl ? ' has-control' : ''}${mediaUnavailable ? ' is-unavailable' : ''}${interactionDisabled ? ' is-disabled' : ''}${draggable.isDragging ? ' is-dragging' : ''}`}
      aria-label="Now playing"
      aria-disabled={interactionDisabled || undefined}
      data-tab-id={selectedTab.id}
    >
      <button
        ref={draggable.setNodeRef}
        type="button"
        className="now-playing-source"
        disabled={interactionDisabled}
        onClick={(event) => {
          if (event.button !== 0 || !gesture.isClick(event)) return;
          if (buttonTab) onFocus(buttonTab);
        }}
        aria-label={showingReturnTab
          ? `Return to previous tab: ${buttonTitle}`
          : `Open audio tab: ${buttonTitle}`}
        title={buttonTitle}
        data-item-drag="true"
        {...draggable.attributes}
        {...draggable.listeners}
        onPointerDownCapture={gesture.onPointerDownCapture}
      >
        <span className="now-playing-source-icon-stage">
          <span
            className={`now-playing-source-icon-cube${showingReturnTab ? ' is-returning' : ''}`}
            data-icon-state={showingReturnTab ? 'return' : 'media'}
          >
            <span className="now-playing-source-icon-face is-media">
              <Favicon
                url={mediaUrl}
                title={mediaTitle}
                sourceUrl={selectedTab.favIconUrl}
              />
            </span>
            <span className="now-playing-source-icon-face is-return" aria-hidden="true">
              <ArrowLeft
                className="now-playing-return-icon"
                size={16}
                strokeWidth={2.25}
              />
            </span>
          </span>
        </span>
      </button>
      {showPlaybackControl && (
        <button
          type="button"
          className="now-playing-control"
          disabled={interactionDisabled || playbackUpdating || mediaUnavailable}
          onClick={onTogglePlayback}
          aria-label={playbackState === 'playing'
            ? `Pause ${mediaTitle}`
            : `Play ${mediaTitle}`}
          title={playbackState === 'playing' ? 'Pause' : 'Play'}
        >
          <PlaybackMorphIcon state={playbackState} />
        </button>
      )}
      {showMuteControl && (
        <button
          type="button"
          className="now-playing-control"
          disabled={interactionDisabled || mediaUnavailable}
          onClick={() => onToggleMuted(selectedTab)}
          aria-label={selectedTab.mutedInfo?.muted
            ? `Unmute ${mediaTitle}`
            : `Mute ${mediaTitle}`}
          title={selectedTab.mutedInfo?.muted ? 'Unmute audio tab' : 'Mute audio tab'}
        >
          {selectedTab.mutedInfo?.muted
            ? <VolumeX size={14} aria-hidden="true" />
            : <Volume2 size={14} aria-hidden="true" />}
        </button>
      )}
    </section>
  );
}