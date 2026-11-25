import { useEffect, useRef, useState } from 'react';
import { useHoldTimer } from './useHoldTimer';
import { listen } from '../lib/listen';

const ARM_DELAY_MS = 500;

/**
 * Whether a panel fills the workspace in place of the active space's tabs and
 * bookmarks: the global bookmarks, or the archived spaces. A drag held over the
 * button that opens one opens it, as a drag held over a view tab switches views.
 * Moving to another space, or Escape, closes it.
 */
export function useWorkspaceOverlay({
  activeSpaceId,
  dragActive,
}: {
  activeSpaceId: string | undefined;
  dragActive: boolean;
}) {
  const [open, setOpenState] = useState(false);
  const hold = useHoldTimer<boolean>(ARM_DELAY_MS);
  const openRef = useRef(false);
  const activeSpaceIdRef = useRef(activeSpaceId);
  activeSpaceIdRef.current = activeSpaceId;
  const reopenInSpaceId = useRef<string | undefined>(undefined);
  const setOpen = (next: boolean) => {
    openRef.current = next;
    setOpenState(next);
  };
  const arm = (over: boolean) => {
    if (!over || openRef.current) {
      if (hold.isArmed()) hold.disarm();
      return;
    }
    hold.arm('open', true, () => setOpen(true));
  };

  useEffect(() => {
    if (!dragActive) hold.disarm();
  }, [dragActive]);
  useEffect(() => {
    setOpen(reopenInSpaceId.current !== undefined && reopenInSpaceId.current === activeSpaceId);
    reopenInSpaceId.current = undefined;
  }, [activeSpaceId]);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !event.isTrusted || dragActive) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"], [role="menu"], [role="dialog"]')) return;
      setOpen(false);
    };
    return listen([window, 'keydown', onKeyDown]);
  }, [dragActive, open]);

  return {
    arm,
    arming: hold.armed === true,
    close: () => setOpen(false),
    open,
    /** Shows or hides them as they were in `spaceId`, once that space is active. */
    restore: (open: boolean, spaceId: string | undefined) => {
      const later = open && spaceId !== activeSpaceIdRef.current;
      reopenInSpaceId.current = later ? spaceId : undefined;
      setOpen(open && !later);
    },
    show: () => setOpen(true),
    toggle: () => setOpen(!openRef.current),
  };
}
