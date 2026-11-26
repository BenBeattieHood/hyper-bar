import { useEffect, useRef } from 'react';
import { useHoldTimer } from './useHoldTimer';

const ARM_DELAY_MS = 500;

export interface SpaceDragView {
  spaceId: string;
  view: 'tabs' | 'bookmarks';
}

interface SpaceDragArmingOptions {
  dragActive: boolean;
  /** Shows the space and list once the drag has been held long enough. */
  open(target: SpaceDragView): void;
  /** Whether the workspace already shows the space and list. */
  showing(target: SpaceDragView): boolean;
}

/**
 * A drag held over a space opens that space to the list its items land in, as
 * a drag held over a view tab switches views.
 */
export function useSpaceDragArming(options: SpaceDragArmingOptions) {
  const latest = useRef(options);
  latest.current = options;
  const hold = useHoldTimer<string>(ARM_DELAY_MS);
  const arm = (target: SpaceDragView | undefined) => {
    if (!target || latest.current.showing(target)) {
      if (hold.isArmed()) hold.disarm();
      return;
    }
    hold.arm(`${target.spaceId}:${target.view}`, target.spaceId, () => {
      if (latest.current.dragActive) latest.current.open(target);
    });
  };

  useEffect(() => {
    if (!options.dragActive) hold.disarm();
  }, [options.dragActive]);

  return { arm, armingSpaceId: hold.armed };
}
