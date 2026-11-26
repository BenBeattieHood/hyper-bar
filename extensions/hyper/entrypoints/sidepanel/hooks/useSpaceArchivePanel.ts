import { useEffect } from 'react';
import { useWorkspaceOverlay } from './useWorkspaceOverlay';

/**
 * Whether the archived spaces fill the workspace. They and the global bookmarks
 * take the same place, so opening one closes the other, and the list closes
 * once nothing is left in it unless a drag may still put a space there.
 */
export function useSpaceArchivePanel({
  activeSpaceId,
  archivedCount,
  dragActive,
  globalPanel,
}: {
  activeSpaceId: string | undefined;
  archivedCount: number;
  dragActive: boolean;
  globalPanel: ReturnType<typeof useWorkspaceOverlay>;
}) {
  const panel = useWorkspaceOverlay({ activeSpaceId, dragActive });
  useEffect(() => {
    if (panel.open) globalPanel.close();
  }, [panel.open]);
  useEffect(() => {
    if (globalPanel.open) panel.close();
  }, [globalPanel.open]);
  useEffect(() => {
    if (!dragActive && archivedCount === 0) panel.close();
  }, [archivedCount, dragActive]);
  return panel;
}
