import type { TimedMessageTone } from '../../lib/timedMessages';

/**
 * Reports something to the user as the window's timed message. A report is
 * model state like any other message, so the header shows it with a copy
 * button and a newer message replaces it (build spec §27).
 */
export type Notify = (message: string, tone?: TimedMessageTone) => void;

/** Errors read as errors; a bare fallback is a refusal, which warns. */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
