interface MutableReference<Value> {
  current: Value;
}

interface LatestSpaceSelectorDependencies {
  deletingSpaceRef: MutableReference<boolean>;
  pendingActiveSpaceIdRef: MutableReference<string | null>;
  reproject(): void;
  runSpaceActivation<Result>(operation: () => Promise<Result>): Promise<Result>;
  spaceActivationVersion: MutableReference<number>;
  /** Resolves once the model admits the choice, carrying its eventual settlement. */
  admitSpaceSelection(spaceId: string): Promise<{ settled: Promise<boolean> } | undefined>;
}

/**
 * Coalesces a burst of space choices into the latest and hands each to the model
 * once the previous one is admitted rather than settled, because the background
 * supersedes a switch still in flight when a newer choice arrives. The chosen
 * space is held on screen only until its command settles.
 */
export function createLatestSpaceSelector(dependencies: LatestSpaceSelectorDependencies) {
  return async (activeSpaceId: string): Promise<boolean> => {
    if (dependencies.deletingSpaceRef.current) {
      throw new Error('Wait for the current space deletion to finish.');
    }
    const activationVersion = ++dependencies.spaceActivationVersion.current;
    dependencies.pendingActiveSpaceIdRef.current = activeSpaceId;
    dependencies.reproject();
    const admitted = await dependencies.runSpaceActivation(async () =>
      activationVersion === dependencies.spaceActivationVersion.current
        ? dependencies.admitSpaceSelection(activeSpaceId)
        : undefined);
    const succeeded = admitted ? await admitted.settled : false;
    // The settling revision already names whatever space the model ended on, so
    // the hold retires here either way; holding past it would let the view
    // contradict the model if anything else moved the window in the meantime.
    if (dependencies.pendingActiveSpaceIdRef.current === activeSpaceId) {
      dependencies.pendingActiveSpaceIdRef.current = null;
      dependencies.reproject();
    }
    return succeeded;
  };
}
