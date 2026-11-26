import { useState } from 'react';
import { errorMessage } from '../lib/notify';

/** A boolean preference whose change travels as an intent and may be refused. */
export function usePreferenceSetting({
  enabled,
  failureNotice,
  onNotice,
  setEnabled,
}: {
  enabled: boolean;
  failureNotice: string;
  onNotice: (message: string) => void;
  setEnabled: (enabled: boolean) => Promise<boolean>;
}) {
  const [isPending, setIsPending] = useState(false);

  const toggle = async () => {
    if (isPending) return;
    setIsPending(true);
    try {
      if (!await setEnabled(!enabled)) throw new Error();
    } catch (error) {
      onNotice(errorMessage(error, failureNotice));
    } finally {
      setIsPending(false);
    }
  };

  return { enabled, isPending, toggle };
}

export type PreferenceSetting = ReturnType<typeof usePreferenceSetting>;
