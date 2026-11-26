import { useEffect, useRef, useState } from 'react';

/**
 * Runs an action once something has been held long enough, as a drag held over
 * a space, a view tab, a panel's button or a collapsed folder opens it. Arming
 * the key already armed keeps its timer running, and `armed` shows what is
 * armed until the timer fires or is disarmed.
 */
export function useHoldTimer<Value extends string | boolean>(delay: number) {
  const [armed, setArmed] = useState<Value>();
  const armedKey = useRef<string | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const disarm = () => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
    armedKey.current = undefined;
    setArmed(undefined);
  };
  const arm = (key: string, value: Value, fire: () => void) => {
    if (armedKey.current === key && timer.current !== undefined) return;
    disarm();
    armedKey.current = key;
    setArmed(value);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      armedKey.current = undefined;
      setArmed(undefined);
      fire();
    }, delay);
  };
  useEffect(() => () => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
  }, []);
  return { arm, armed, disarm, isArmed: () => timer.current !== undefined };
}
