import type { BrowserTab } from '../../lib/bookmarks';
import type { RemoteTabReference } from '../../lib/remoteTab';
import { errorMessage, type Notify } from './notify';

interface SpaceIndicatorActionDependencies {
  clearSelectedAfter<Result>(operation: Promise<Result>): Promise<Result>;
  closeTabsInSpace(source: RemoteTabReference, spaceId: string): Promise<void>;
  focusRemoteTab(source: RemoteTabReference, spaceId: string): Promise<void>;
  moveRemoteTabToWindow(source: RemoteTabReference, spaceId: string): Promise<void>;
  openBookmark(
    url: string,
    options: { destinationSpaceId: string },
  ): Promise<BrowserTab | undefined>;
  showNotice: Notify;
}

export function shouldUseRemoteSpaceAction(
  remoteSpaceIds: readonly string[],
  localSpaceIds: ReadonlySet<string> | undefined,
  spaceId: string,
): boolean {
  return remoteSpaceIds.includes(spaceId) && !localSpaceIds?.has(spaceId);
}

export function createSpaceIndicatorActions(
  dependencies: SpaceIndicatorActionDependencies,
) {
  return {
    // Closes the page wherever that space has it open, this window included.
    closeInSpace(source: RemoteTabReference, spaceId: string) {
      void dependencies.closeTabsInSpace(source, spaceId).catch((error) => dependencies.showNotice(
        errorMessage(error, 'The tabs could not be closed'),
      ));
    },
    // The background takes the window to that space and shows the page there.
    openLocal(url: string, spaceId: string) {
      void dependencies.clearSelectedAfter(
        dependencies.openBookmark(url, { destinationSpaceId: spaceId }),
      ).catch((error) => dependencies.showNotice(
        errorMessage(error, 'The page could not be opened'),
      ));
    },
    openRemote(
      source: RemoteTabReference,
      spaceId: string,
      moveToCurrentWindow: boolean,
    ) {
      const operation = moveToCurrentWindow
        ? dependencies.moveRemoteTabToWindow(source, spaceId)
        : dependencies.focusRemoteTab(source, spaceId);
      void dependencies.clearSelectedAfter(operation).catch((error) => dependencies.showNotice(
        errorMessage(
          error,
          moveToCurrentWindow ? 'The remote tab could not be moved' : 'The remote tab could not be focused',
        ),
      ));
    },
  };
}