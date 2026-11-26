import { useCallback, useRef, useState, type ChangeEvent } from 'react';
import {
  clampTimedMessageSeconds,
  TIMED_MESSAGE_MAX_SECONDS,
  TIMED_MESSAGE_MIN_SECONDS,
} from '../../lib/preferences';
import { listen } from '../lib/listen';

/**
 * How long timed messages stay up. Dragging shows each value at once, and the
 * native change event, which fires when a drag ends or a key steps the value,
 * saves it, so one drag writes the root folder once.
 */
export function useTimedMessageSetting({
  onNotice,
  saved,
  save,
}: {
  onNotice: (message: string) => void;
  saved: number;
  save: (seconds: number) => Promise<boolean>;
}) {
  const [adjusting, setAdjusting] = useState<number>();
  const seconds = adjusting ?? saved;
  const latest = useRef({ onNotice, save, saved });
  latest.current = { onNotice, save, saved };

  const ref = useCallback((input: HTMLInputElement | null) => {
    if (!input) return undefined;
    const commit = () => {
      const next = clampTimedMessageSeconds(Number(input.value));
      setAdjusting(undefined);
      const current = latest.current;
      if (next === current.saved) return;
      void current.save(next)
        .then((saved) => { if (!saved) throw new Error(); })
        .catch(() => latest.current.onNotice('The message timing setting could not be changed'));
    };
    return listen([input, 'change', commit]);
  }, []);

  return {
    seconds,
    inputProps: {
      'aria-valuetext': `${seconds} seconds`,
      max: TIMED_MESSAGE_MAX_SECONDS,
      min: TIMED_MESSAGE_MIN_SECONDS,
      onChange: (event: ChangeEvent<HTMLInputElement>) =>
        setAdjusting(clampTimedMessageSeconds(Number(event.currentTarget.value))),
      ref,
      step: 1,
      type: 'range' as const,
      value: seconds,
    },
  };
}
