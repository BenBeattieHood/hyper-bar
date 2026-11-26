/**
 * Counts the backing operations the sidebar has in flight and reports the total
 * whenever it changes, so the view can show a busy state without each caller
 * having to touch shared state.
 *
 * It is deliberately free of React: the increment-on-start, floor-at-zero
 * decrement-on-finish rule, and the fact that a throwing operation still clears
 * its slot, are all testable without a rendered hook.
 */
export interface PendingOperationGauge {
  /** Runs an operation while it is counted as in flight, reporting each change. */
  track<T>(operation: () => Promise<T>): Promise<T>;
  /** The current number of in-flight operations. */
  count(): number;
}

export function createPendingOperationGauge(
  onChange: (count: number) => void,
): PendingOperationGauge {
  let inFlight = 0;
  const track = async <T>(operation: () => Promise<T>): Promise<T> => {
    inFlight += 1;
    onChange(inFlight);
    try {
      return await operation();
    } finally {
      inFlight = Math.max(0, inFlight - 1);
      onChange(inFlight);
    }
  };
  return { count: () => inFlight, track };
}
