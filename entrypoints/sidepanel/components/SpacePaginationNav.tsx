import { SortableContext, type SortingStrategy } from '@dnd-kit/sortable';
import { Plus } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import type { BrowserTab, Space } from '../../lib/bookmarks';
import { shortcutButtonProps, spaceShortcutId } from '../../lib/shortcuts';
import type { useBrowserState } from '../hooks/useBrowserState';
import type { useMediaControls } from '../hooks/useMediaControls';
import type { useWorkspaceOverlay } from '../hooks/useWorkspaceOverlay';
import type { DragItemData } from '../types';
import { NowPlaying } from './NowPlaying';
import { SpaceArchiveButton } from './SpaceArchivePanel';
import {
  SpacePaginationButton,
  SpacePaginationTrashTarget,
  updateSpacePaginationLayout,
} from './SpacePagination';
import { presenceMotion } from './WorkspaceMotion';

type BrowserStateApi = ReturnType<typeof useBrowserState>;

// A space dropped on a dot lands beside its nearer edge, so the dots hold still under the pointer and a bar marks that edge.
const dotsStayPut: SortingStrategy = () => null;

export function SpacePaginationNav({
  activeDrag,
  activeDragTrashDisabled,
  activeDragTrashLabel,
  activeSpace,
  archivePanel,
  archivedSpaces,
  armingSpaceId,
  browserState,
  createSpace,
  dragOverTarget,
  extensionOrigin,
  focusAudibleTab,
  mediaControls,
  mediaControlsDragDisabled,
  mediaReturnTab,
  noticeOnFailure,
  openSpaceMenu,
  reduceMotion,
  selectSpace,
  spaces,
  toggleAudibleTabMuted,
  spaceInsertion,
}: {
  activeDrag: DragItemData | undefined;
  activeDragTrashDisabled: boolean;
  activeDragTrashLabel: string | null | undefined;
  activeSpace: Space;
  archivePanel: ReturnType<typeof useWorkspaceOverlay>;
  archivedSpaces: readonly Space[];
  /** The space a held drag is about to open. */
  armingSpaceId: string | undefined;
  browserState: BrowserStateApi;
  createSpace(): Promise<void>;
  dragOverTarget: DragItemData | undefined;
  extensionOrigin: string;
  focusAudibleTab(tab: BrowserTab): Promise<void>;
  mediaControls: ReturnType<typeof useMediaControls>;
  mediaControlsDragDisabled: boolean;
  mediaReturnTab: BrowserTab | undefined;
  noticeOnFailure(fallback: string): (error: unknown) => void;
  openSpaceMenu(event: MouseEvent<HTMLElement>, space: Space): void;
  reduceMotion: boolean | null;
  selectSpace(spaceId: string): Promise<boolean>;
  spaces: Space[];
  toggleAudibleTabMuted(tab: BrowserTab): Promise<void>;
  /** The dot, and which side of it, a space dragged over the pagination would land beside. */
  spaceInsertion: { after: boolean; spaceId: string } | undefined;
}) {
  const showsArchive = archivedSpaces.length > 0 || activeDrag?.kind === 'space';
  const unarchiving = activeDrag?.kind === 'space' && Boolean(activeDrag.archived);
  const spacePaginationItemsRef = useRef<HTMLDivElement>(null);
  const [hoveredSpaceId, setHoveredSpaceId] = useState<string>();
  const hoveredSpaceIdRef = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const items = spacePaginationItemsRef.current;
    if (!items) return;
    const update = () => updateSpacePaginationLayout(items);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(items);
    return () => observer.disconnect();
  }, [activeDrag?.kind, activeSpace?.id, showsArchive, spaces]);

  return (
    <nav
      className={`space-pagination${activeDrag && dragOverTarget?.kind === 'trash' ? ' is-trash-over' : ''}`}
      aria-label="Spaces"
    >
        <div className="space-pagination-rail space-pagination-rail-start">
          <div className="now-playing-slot">
            <AnimatePresence initial={false}>
              {mediaControls.displayTabs.length > 0 && (
                <motion.div
                  key="now-playing"
                  className="now-playing-transition"
                  animate={{ opacity: 1, x: 0 }}
                  {...presenceMotion(reduceMotion, { opacity: 0, x: -8 }, { opacity: 0, x: -8 }, { duration: 0.18 })}
                >
                  <NowPlaying
                    tabs={mediaControls.displayTabs}
                    returnTab={mediaReturnTab}
                    extensionOrigin={extensionOrigin}
                    dropDisabled={browserState.isBackingOperationPending || Boolean(activeDrag)}
                    interactionDisabled={mediaControlsDragDisabled}
                    mediaUnavailable={mediaControls.isUnavailable}
                    playbackAccessEnabled={mediaControls.playbackAccessEnabled}
                    playbackState={mediaControls.playbackState}
                    playbackUpdating={mediaControls.isUpdating}
                    onFocus={(tab) => void focusAudibleTab(tab)}
                    onTogglePlayback={() => {
                      void mediaControls.togglePlayback()
                        .catch(noticeOnFailure('Playback could not be changed'));
                    }}
                    onToggleMuted={(tab) => void toggleAudibleTabMuted(tab)}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
        <div
          ref={spacePaginationItemsRef}
          className={`space-pagination-items${showsArchive ? ' has-archive' : ''}${activeDrag?.kind === 'space' ? ' is-space-dragging' : ''}${activeDrag && dragOverTarget?.kind === 'trash' ? ' is-trash-over' : ''}`}
        >
          {showsArchive && (
            <SpaceArchiveButton
              activeDrag={activeDrag}
              arming={archivePanel.arming}
              onToggle={archivePanel.toggle}
              open={archivePanel.open}
            />
          )}
          <div className="space-pagination-dots">
            <SortableContext
              items={spaces.map((space) => `space:${space.id}`)}
              strategy={dotsStayPut}
            >
              {spaces.map((space, index) => (
                <SpacePaginationButton
                  key={space.id}
                  space={space}
                  active={space.id === activeSpace.id}
                  dragArming={armingSpaceId === space.id}
                  dropActive={Boolean(activeDrag && (activeDrag.kind !== 'space' || unarchiving))}
                  insertion={spaceInsertion?.spaceId === space.id
                    ? spaceInsertion.after ? 'after' : 'before'
                    : undefined}
                  dropDisabled={activeDrag?.kind === 'tree' &&
                    (!space.rootId || activeDrag.parentId === space.rootId)}
                  hovered={hoveredSpaceId === space.id}
                  colour={space.colour}
                  reduceMotion={Boolean(reduceMotion)}
                  onHover={(spaceId) => {
                    hoveredSpaceIdRef.current = spaceId;
                    setHoveredSpaceId(spaceId);
                  }}
                  onHoverEnd={(spaceId) => {
                    if (hoveredSpaceIdRef.current !== spaceId) return;
                    hoveredSpaceIdRef.current = undefined;
                    setHoveredSpaceId(undefined);
                  }}
                  onMenu={(event) => {
                    // A drag owns the pointer; a menu opening over it would strand the drop.
                    if (activeDrag) event.preventDefault();
                    else openSpaceMenu(event, space);
                  }}
                  onSelect={() => void selectSpace(space.id)}
                  shortcutId={spaceShortcutId(index)}
                />
              ))}
            </SortableContext>
          </div>
          {activeDrag && activeDragTrashLabel ? (
            <SpacePaginationTrashTarget
              disabled={activeDragTrashDisabled}
              label={activeDragTrashLabel}
            />
          ) : (
            <button
              type="button"
              className="space-pagination-action space-pagination-tail-action add-space-button"
              onClick={() => void createSpace()}
              aria-label="Add space"
              {...shortcutButtonProps('newSpace')}
            >
              <Plus size={14} aria-hidden="true" />
            </button>
          )}
        </div>
    </nav>
  );
}
