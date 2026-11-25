import {
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  BOOKMARK_PANEL_MAX_PERCENT,
  BOOKMARK_PANEL_MIN_PERCENT,
  clampBookmarkPanelPercent,
  defaultHyperPreferences,
} from '../../lib/preferences';
import { clamp } from '../../lib/collections';

const PANEL_MIN_HEIGHT = 96;
const KEY_STEP = 5;

/** Where the pointer puts the split, keeping each panel tall enough to use. */
function pointerPercent(clientY: number, splitter: HTMLElement): number | undefined {
  const container = splitter.parentElement;
  if (!container) return undefined;
  const bounds = container.getBoundingClientRect();
  const availableHeight = Math.max(bounds.height - splitter.offsetHeight, 1);
  const minimumPercent = Math.max(
    BOOKMARK_PANEL_MIN_PERCENT,
    Math.min(45, PANEL_MIN_HEIGHT / availableHeight * 100),
  );
  const percent = (clientY - bounds.top - splitter.offsetHeight / 2) / availableHeight * 100;
  return clamp(percent, minimumPercent, 100 - minimumPercent);
}

/**
 * The Tabs/Bookmarks split in the combined workspace. A drag or key press shows
 * at once and is saved as a preference when it ends, so reopening keeps it.
 */
export function useBookmarkPanelSplit(saved: number, save: (percent: number) => void) {
  const [adjusting, setAdjusting] = useState<number>();
  const percent = adjusting ?? saved;
  const commit = (next: number) => {
    setAdjusting(undefined);
    save(clampBookmarkPanelPercent(next));
  };
  const keyPercent = (key: string) => {
    if (key === 'ArrowUp') return percent - KEY_STEP;
    if (key === 'ArrowDown') return percent + KEY_STEP;
    if (key === 'Home') return BOOKMARK_PANEL_MIN_PERCENT;
    if (key === 'End') return BOOKMARK_PANEL_MAX_PERCENT;
    return undefined;
  };

  return {
    percent,
    splitterProps: {
      'aria-label': 'Resize bookmarks and tabs panels',
      'aria-orientation': 'horizontal' as const,
      'aria-valuemax': BOOKMARK_PANEL_MAX_PERCENT,
      'aria-valuemin': BOOKMARK_PANEL_MIN_PERCENT,
      'aria-valuenow': Math.round(percent),
      role: 'separator',
      tabIndex: 0,
      onDoubleClick: () => commit(defaultHyperPreferences.bookmarkPanelPercent),
      onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
        const next = keyPercent(event.key);
        if (next === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        setAdjusting(clampBookmarkPanelPercent(next));
      },
      // A held key repeats keydown but releases once, so one hold saves once.
      onKeyUp: (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (adjusting !== undefined && keyPercent(event.key) !== undefined) commit(adjusting);
      },
      onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        setAdjusting(pointerPercent(event.clientY, event.currentTarget));
      },
      onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        event.stopPropagation();
        setAdjusting(pointerPercent(event.clientY, event.currentTarget));
      },
      onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        event.stopPropagation();
        const next = pointerPercent(event.clientY, event.currentTarget);
        if (next === undefined) setAdjusting(undefined);
        else commit(next);
      },
      onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        setAdjusting(undefined);
      },
    },
  };
}
