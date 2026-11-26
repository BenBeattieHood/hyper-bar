import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Space } from '../../lib/bookmarks';
import type {
  SlideDirection,
  WorkspaceSlideIntent,
  WorkspaceTransitionKind,
} from '../components/WorkspaceMotion';
import { errorMessage, type Notify } from '../lib/notify';
import type { useBrowserState } from './useBrowserState';

const SWIPE_DISTANCE = 54;

type BrowserStateApi = ReturnType<typeof useBrowserState>;

export function useSpaceNavigation({
  activeSpace,
  browserState,
  clearSelectedTabs,
  setWorkspaceTransitionKind,
  showNotice,
  spaces,
  workspaceTransitionKind,
}: {
  activeSpace: Space | undefined;
  browserState: BrowserStateApi;
  clearSelectedTabs(): void;
  setWorkspaceTransitionKind(kind: WorkspaceTransitionKind): void;
  showNotice: Notify;
  spaces: Space[];
  workspaceTransitionKind: WorkspaceTransitionKind;
}) {
  const [swipeDirection, setSwipeDirection] = useState<'left' | 'right'>('left');
  const [shownSpace, setShownSpace] = useState<{ id: string; index: number }>();
  const swipeStart = useRef<{ x: number; y: number } | undefined>(undefined);
  const latestSelection = useRef(0);
  const activeSpaceIndex = activeSpace
    ? spaces.findIndex((space) => space.id === activeSpace.id)
    : 0;
  // A space the model moved to slides by index; only the sidebar's own swipe knows it wrapped around.
  if (activeSpace && shownSpace?.id !== activeSpace.id) {
    setShownSpace({ id: activeSpace.id, index: activeSpaceIndex });
    if (shownSpace) {
      setWorkspaceTransitionKind('space');
      setSwipeDirection(activeSpaceIndex > shownSpace.index ? 'left' : 'right');
    }
  }
  const spaceSlideDirection: SlideDirection = swipeDirection === 'left' ? 1 : -1;
  const tabsSlideIntent: WorkspaceSlideIntent = {
    direction: workspaceTransitionKind === 'space' ? spaceSlideDirection : -1,
    kind: workspaceTransitionKind,
  };
  const bookmarksSlideIntent: WorkspaceSlideIntent = {
    direction: 1,
    kind: 'view',
  };

  const selectSpace = async (
    spaceId: string,
    direction?: 'left' | 'right',
  ): Promise<boolean> => {
    const nextIndex = spaces.findIndex((space) => space.id === spaceId);
    if (nextIndex < 0) return false;
    if (spaceId === activeSpace?.id) return true;
    setWorkspaceTransitionKind('space');
    setSwipeDirection(
      direction ?? (nextIndex > activeSpaceIndex ? 'left' : 'right'),
    );
    setShownSpace({ id: spaceId, index: nextIndex });
    // A quicker later pick owns the selection; this one must not clear it or report over it.
    const selection = ++latestSelection.current;
    try {
      const selected = await browserState.setActiveSpaceId(spaceId);
      if (selected && selection === latestSelection.current) clearSelectedTabs();
      return selected;
    } catch (error) {
      if (selection === latestSelection.current) {
        showNotice(errorMessage(error, 'Space tabs could not be reconciled'));
      }
      return false;
    }
  };

  const stepSpace = (offset: number) => {
    if (spaces.length < 2) return;
    const nextIndex = (activeSpaceIndex + offset + spaces.length) % spaces.length;
    const nextSpace = spaces[nextIndex];
    if (!nextSpace) return;
    void selectSpace(nextSpace.id, offset > 0 ? 'left' : 'right');
  };

  const onSwipeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('button, input, [data-item-drag]')) return;
    swipeStart.current = { x: event.clientX, y: event.clientY };
  };

  const onSwipeEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = swipeStart.current;
    swipeStart.current = undefined;
    if (!start) return;
    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    if (Math.abs(deltaX) < SWIPE_DISTANCE || Math.abs(deltaX) < Math.abs(deltaY)) {
      return;
    }
    stepSpace(deltaX < 0 ? 1 : -1);
  };

  return {
    bookmarksSlideIntent,
    onSwipeEnd,
    onSwipeStart,
    selectSpace,
    spaceSlideDirection,
    stepSpace,
    swipeStart,
    tabsSlideIntent,
  };
}
