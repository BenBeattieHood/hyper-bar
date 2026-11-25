import type { KeyboardEvent } from 'react';

/** Keeps Tab within a modal dialog and closes it on Escape. */
export function trapDialogFocus(event: KeyboardEvent<HTMLElement>, onClose: () => void): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    onClose();
    return;
  }
  if (event.key !== 'Tab') return;
  const controls = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  );
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
