import { CommandFailureError } from './modelActions';
import { intentHandler, type HyperIntentHandlers } from './modelIntents';
import { requireString } from './modelIntentPayloads';
import { windowTarget } from './modelGuards';
import { defaultHyperPreferences } from './preferences';

/** How long a message stays up until the user picks another duration in Settings. */
export const DEFAULT_TIMED_MESSAGE_MS = defaultHyperPreferences.timedMessageSeconds * 1_000;
const MAX_TEXT_LENGTH = 500;

/**
 * Each kind fixes its button's icon (build spec §27): opt-in is a tick, opt-out
 * a cross, undo an undo arrow and feedback a copy button.
 */
export type TimedMessageKind = 'feedback' | 'opt-in' | 'opt-out' | 'undo';
export type TimedMessageTone = 'error' | 'info' | 'warning';

const tones: readonly TimedMessageTone[] = ['error', 'info', 'warning'];

/** The projected half of a message; what its button does stays in the background. */
export interface TimedMessage {
  detail?: string;
  durationMs: number;
  expiresAt: number;
  id: string;
  kind: TimedMessageKind;
  /** A message about one tab lasts only while that tab is in its window. */
  tabId?: number;
  text: string;
  tone: TimedMessageTone;
}

/**
 * IDs that undos earlier in the same series gave the bookmarks they made
 * again, keyed by the originals' IDs, so a later undo finds a folder an
 * earlier one made again. Each undo adds what it makes.
 */
export type RemadeBookmarks = Map<string, string>;

/**
 * Marks an undo as one of a run of like actions. While its message shows, the
 * next undo offer with the same key joins it rather than replacing it: the
 * message counts the items of both and starts its time again, and its Undo
 * undoes both, newest first.
 */
export interface UndoSeries {
  /** What the action did to, so doing it to the same item twice counts it once. */
  items: readonly string[];
  key: string;
  /** The message for a run that did something to `count` items. */
  summary(count: number): string;
}

export interface TimedOffer {
  /** Runs at most once, and only while this offer is its window's message. */
  act(remade: RemadeBookmarks): Promise<void>;
  detail?: string;
  /**
   * Starts the action as the press is admitted, while the browser still counts
   * it as the user's gesture, which a permission prompt needs. The action must
   * make that browser call before its first await.
   */
  gesture?: boolean;
  kind: Exclude<TimedMessageKind, 'feedback'>;
  series?: UndoSeries;
  tabId?: number;
  text: string;
  tone?: TimedMessageTone;
}

interface Entry {
  act?: (remade: RemadeBookmarks) => Promise<void>;
  gesture?: boolean;
  message: TimedMessage;
  series?: UndoSeries;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Undoes the newest action first, as each was done on top of the one before.
 * One that fails does not stop the older ones; the first failure is reported.
 */
const undoBoth = (
  newer: (remade: RemadeBookmarks) => Promise<void>,
  older: (remade: RemadeBookmarks) => Promise<void>,
) => async (remade: RemadeBookmarks) => {
  const failures: unknown[] = [];
  for (const undo of [newer, older]) await undo(remade).catch((error: unknown) => void failures.push(error));
  if (failures.length > 0) throw failures[0];
};

export interface TimedMessagesDependencies {
  /** Read as each message shows, so a changed preference applies to the next one. */
  durationMs?: () => number;
  now?: () => number;
  reconcile(): Promise<unknown>;
}

type TimedMessageIntentKind = 'actOnTimedMessage' | 'dismissTimedMessage' | 'showMessage';

function boundedText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_TEXT_LENGTH ? `${trimmed.slice(0, MAX_TEXT_LENGTH - 1)}…` : trimmed;
}

function parseShowMessagePayload(payload: unknown): { text: string; tone: TimedMessageTone } {
  const text = boundedText(requireString(payload, 'text'));
  const tone = requireString(payload, 'tone') as TimedMessageTone;
  if (!text) throw new Error('A message needs text.');
  if (!tones.includes(tone)) throw new Error(`Unknown message tone: ${tone}.`);
  return { text, tone };
}

/** Drops a tab's message once the model no longer sees that tab in its window. */
export function currentTimedMessages(
  tabs: readonly Pick<Browser.tabs.Tab, 'id' | 'windowId'>[],
  messages: Readonly<Record<number, TimedMessage>>,
): Readonly<Record<number, TimedMessage>> {
  return Object.fromEntries(Object.entries(messages).filter(([windowId, message]) =>
    message.tabId === undefined ||
    tabs.some((tab) => tab.id === message.tabId && tab.windowId === Number(windowId))));
}

/**
 * Holds the one timed message each window shows. A newer message replaces the
 * older one outright, and with it whatever the older one could still do, so
 * messages never stack and an undo never outlives the message that offers it.
 * Expiry only forgets: it never runs a message's action.
 */
export function createTimedMessages(dependencies: TimedMessagesDependencies) {
  const now = dependencies.now ?? Date.now;
  const durationMs = dependencies.durationMs ?? (() => DEFAULT_TIMED_MESSAGE_MS);
  const entries = new Map<number, Entry>();
  const reconcile = () => void dependencies.reconcile().catch((error) => {
    console.error('Unable to reconcile timed messages.', error);
  });

  const dismiss = (windowId: number, id?: string): Entry | undefined => {
    const entry = entries.get(windowId);
    if (!entry || (id !== undefined && entry.message.id !== id)) return undefined;
    clearTimeout(entry.timer);
    entries.delete(windowId);
    reconcile();
    return entry;
  };

  const show = (
    windowId: number,
    message: Omit<TimedMessage, 'expiresAt' | 'id'>,
    act?: (remade: RemadeBookmarks) => Promise<void>,
    gesture?: boolean,
    series?: UndoSeries,
  ): string => {
    const previous = entries.get(windowId);
    if (previous) clearTimeout(previous.timer);
    const id = crypto.randomUUID();
    const timer = setTimeout(() => dismiss(windowId, id), message.durationMs);
    entries.set(windowId, {
      ...(act ? { act } : {}),
      ...(gesture ? { gesture } : {}),
      message: { ...message, expiresAt: now() + message.durationMs, id },
      ...(series ? { series } : {}),
      timer,
    });
    reconcile();
    return id;
  };

  const notify = (windowId: number, text: string, tone: TimedMessageTone = 'info'): string =>
    show(windowId, { durationMs: durationMs(), kind: 'feedback', text: boundedText(text), tone });

  /** Takes the message down and runs its action once, reporting a failure in its window. */
  const act = (windowId: number, entry: Entry & Required<Pick<Entry, 'act'>>): Promise<void> => {
    dismiss(windowId, entry.message.id);
    let acting: Promise<void>;
    try {
      acting = entry.act(new Map());
    } catch (error) {
      acting = Promise.reject(error);
    }
    return acting.catch((error: unknown) => {
      notify(windowId, error instanceof Error ? error.message : String(error), 'error');
      throw error;
    });
  };

  const actionFor = (windowId: number, messageId: string) => {
    const entry = entries.get(windowId);
    return entry?.act && entry.message.id === messageId ? { ...entry, act: entry.act } : undefined;
  };

  return {
    current: (windowId: number): TimedMessage | undefined => entries.get(windowId)?.message,

    dismiss: (windowId: number, id?: string) => void dismiss(windowId, id),

    notify,

    /** Shows a best guess the user can take, decline or undo with one press. */
    offer: (windowId: number, offer: TimedOffer): string => {
      const { act: action, gesture, kind, series, tone = 'info' } = offer;
      const previous = entries.get(windowId);
      const joined = kind === 'undo' && series && previous?.act && previous.series?.key === series.key
        ? { ...previous, act: previous.act, series: previous.series }
        : undefined;
      const items = joined ? [...new Set([...joined.series.items, ...series!.items])] : series?.items;
      // A run that has only redone the newest offer's items reads as that offer.
      const { detail, tabId, text } = !joined || items!.length === new Set(series!.items).size
        ? offer
        : { text: series!.summary(items!.length) };
      return show(windowId, {
        ...(detail ? { detail } : {}),
        durationMs: durationMs(),
        kind,
        ...(tabId === undefined ? {} : { tabId }),
        text,
        tone,
      }, joined ? undoBoth(action, joined.act) : action, gesture, series && { ...series, items: items! });
    },

    removeTab(tabId: number) {
      for (const [windowId, entry] of entries) {
        if (entry.message.tabId === tabId) dismiss(windowId, entry.message.id);
      }
    },

    runtimeSignals: () => ({
      timedMessages: Object.fromEntries([...entries].map(([windowId, entry]) => [windowId, entry.message])),
    }),

    handlers: {
      actOnTimedMessage: intentHandler({
        admit: (messageId, client) => {
          const entry = actionFor(client.windowId, messageId);
          return entry?.gesture ? act(client.windowId, entry) : undefined;
        },
        parse: (payload: unknown) => requireString(payload, 'messageId'),
        run: async (messageId, client, _effects, started) => {
          if (started) return started;
          const entry = actionFor(client.windowId, messageId);
          if (!entry) {
            throw new CommandFailureError('precondition-failed', 'This message has expired.');
          }
          await act(client.windowId, entry);
        },
        targets: (_messageId, client) => [windowTarget(client.windowId)],
      }),
      /** Closes the message as if it had expired; one already gone needs nothing. */
      dismissTimedMessage: intentHandler({
        parse: (payload: unknown) => requireString(payload, 'messageId'),
        run: async (messageId, client) => void dismiss(client.windowId, messageId),
        targets: (_messageId, client) => [windowTarget(client.windowId)],
      }),
      showMessage: intentHandler({
        parse: parseShowMessagePayload,
        run: async ({ text, tone }, client) => void notify(client.windowId, text, tone),
        targets: () => [],
      }),
    } satisfies Pick<HyperIntentHandlers, TimedMessageIntentKind>,
  };
}

export type TimedMessages = ReturnType<typeof createTimedMessages>;
