import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HyperModelPortClient } from './modelPort';
import {
  createTimedMessages,
  currentTimedMessages,
  DEFAULT_TIMED_MESSAGE_MS,
  type TimedMessage,
} from './timedMessages';

const client: HyperModelPortClient = { clientId: 'sidebar', role: 'sidebar', windowId: 1 };

function install() {
  const reconcile = vi.fn(async () => undefined);
  return { messages: createTimedMessages({ now: () => 1_000, reconcile }), reconcile };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('timed messages', () => {
  it('shows one message per window, a newer one replacing the older and what it could do', async () => {
    const { messages } = install();
    const undo = vi.fn(async () => undefined);
    const first = messages.offer(1, { act: undo, kind: 'undo', text: 'Deleted bookmark' });
    messages.offer(2, { act: undo, kind: 'undo', text: 'Moved bookmark' });

    messages.notify(1, 'Copied', 'info');

    expect(Object.keys(messages.runtimeSignals().timedMessages)).toEqual(['1', '2']);
    expect(messages.current(1)).toMatchObject({ durationMs: DEFAULT_TIMED_MESSAGE_MS, kind: 'feedback', text: 'Copied' });
    await expect(messages.handlers.actOnTimedMessage.run({ messageId: first }, client))
      .rejects.toThrow('expired');
    expect(undo).not.toHaveBeenCalled();
  });

  describe('undo series', () => {
    const closed = (...items: string[]) => ({ items, key: 'closed-tabs', summary: (count: number) => `Closed ${count} tabs` });

    it('joins a like undo while it shows: counts both, starts its time again, and undoes newest first', async () => {
      vi.useFakeTimers();
      const { messages } = install();
      const undone: string[] = [];
      const undo = (name: string, made?: [string, string]) => vi.fn(async (remade: Map<string, string>) => {
        undone.push(`${name} sees ${[...remade.keys()].join(',') || 'nothing'}`);
        if (made) remade.set(...made);
      });
      messages.offer(1, { act: undo('first'), detail: 'Page a', kind: 'undo', series: closed('a'), text: 'Closed tab' });
      vi.advanceTimersByTime(DEFAULT_TIMED_MESSAGE_MS - 1);
      const messageId = messages.offer(1, {
        act: undo('folder', ['folder', 'new-folder']),
        detail: 'Reading',
        kind: 'undo',
        series: closed('b', 'c'),
        text: 'Closed folder',
      });

      vi.advanceTimersByTime(DEFAULT_TIMED_MESSAGE_MS - 1);
      expect(messages.current(1)).toMatchObject({ kind: 'undo', text: 'Closed 3 tabs' });
      expect(messages.current(1)).not.toHaveProperty('detail');
      await messages.handlers.actOnTimedMessage.run({ messageId }, client);

      // The older undo sees the folder the newer one made again.
      expect(undone).toEqual(['folder sees nothing', 'first sees folder']);
    });

    it('reads as the newest offer while the run has only redone its items', () => {
      const { messages } = install();
      const act = async () => undefined;
      messages.offer(1, { act, detail: 'Page a', kind: 'undo', series: closed('a'), text: 'Moved tab' });
      messages.offer(1, { act, detail: 'Page a', kind: 'undo', series: closed('a'), text: 'Moved tab' });

      expect(messages.current(1)).toMatchObject({ detail: 'Page a', text: 'Moved tab' });
    });

    it('starts afresh after the message goes, or after an unlike message replaced it', async () => {
      vi.useFakeTimers();
      const { messages } = install();
      const older = vi.fn(async () => undefined);
      const act = async () => undefined;
      messages.offer(1, { act: older, kind: 'undo', series: closed('a'), text: 'Closed tab' });
      vi.advanceTimersByTime(DEFAULT_TIMED_MESSAGE_MS);
      messages.offer(1, { act: older, kind: 'undo', series: closed('b'), text: 'Closed tab' });
      messages.offer(1, { act, kind: 'undo', series: { ...closed('c'), key: 'deleted' }, text: 'Deleted bookmark' });
      const messageId = messages.offer(1, { act, kind: 'undo', series: closed('d'), text: 'Closed tab' });

      expect(messages.current(1)).toMatchObject({ text: 'Closed tab' });
      await messages.handlers.actOnTimedMessage.run({ messageId }, client);
      expect(older).not.toHaveBeenCalled();
    });

    it('still undoes the older actions when a newer undo fails, then reports the failure', async () => {
      const { messages } = install();
      const older = vi.fn(async () => undefined);
      messages.offer(1, { act: older, kind: 'undo', series: closed('a'), text: 'Closed tab' });
      const messageId = messages.offer(1, {
        act: async () => { throw new Error('That tab folder no longer exists.'); },
        kind: 'undo',
        series: closed('b'),
        text: 'Closed tab',
      });

      await expect(messages.handlers.actOnTimedMessage.run({ messageId }, client)).rejects.toThrow('no longer exists');
      expect(older).toHaveBeenCalledTimes(1);
      expect(messages.current(1)).toMatchObject({ text: 'That tab folder no longer exists.', tone: 'error' });
    });
  });

  it('forgets a message when it expires without acting on it', () => {
    vi.useFakeTimers();
    const { messages, reconcile } = install();
    const act = vi.fn(async () => undefined);
    messages.offer(1, { act, kind: 'opt-in', text: 'Deduplicate?' });

    vi.advanceTimersByTime(DEFAULT_TIMED_MESSAGE_MS - 1);
    expect(messages.current(1)).toBeDefined();
    vi.advanceTimersByTime(1);

    expect(messages.current(1)).toBeUndefined();
    expect(act).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('reports a reconciliation failure', async () => {
    const failure = new Error('Reconciliation failed.');
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const messages = createTimedMessages({
      reconcile: async () => { throw failure; },
    });

    messages.notify(1, 'Copied');

    await vi.waitFor(() => {
      expect(report).toHaveBeenCalledWith('Unable to reconcile timed messages.', failure);
    });
  });

  it('gives each message the duration chosen when it shows', () => {
    vi.useFakeTimers();
    let seconds = 3;
    const messages = createTimedMessages({
      durationMs: () => seconds * 1_000,
      now: () => 1_000,
      reconcile: async () => undefined,
    });

    messages.notify(1, 'Copied');
    expect(messages.current(1)).toMatchObject({ durationMs: 3_000, expiresAt: 4_000 });
    seconds = 15;
    messages.offer(2, { act: async () => undefined, kind: 'undo', text: 'Moved tab' });
    expect(messages.current(2)).toMatchObject({ durationMs: 15_000, expiresAt: 16_000 });

    vi.advanceTimersByTime(3_000);
    expect(messages.current(1)).toBeUndefined();
    expect(messages.current(2)).toBeDefined();
    vi.advanceTimersByTime(12_000);
    expect(messages.current(2)).toBeUndefined();
  });

  it('acts once, dismissing the message first', async () => {
    const { messages } = install();
    const act = vi.fn(async () => expect(messages.current(1)).toBeUndefined());
    const messageId = messages.offer(1, { act, kind: 'opt-out', text: 'Linked to bookmark' });

    await messages.handlers.actOnTimedMessage.run({ messageId }, client);

    expect(act).toHaveBeenCalledTimes(1);
    await expect(messages.handlers.actOnTimedMessage.run({ messageId }, client)).rejects.toThrow();
    expect(act).toHaveBeenCalledTimes(1);
  });

  it('closes the message without acting, leaving a newer one in place', async () => {
    const { messages } = install();
    const act = vi.fn(async () => undefined);
    const stale = messages.offer(1, { act, kind: 'undo', text: 'Moved bookmark' });
    const messageId = messages.offer(1, { act, kind: 'undo', text: 'Deleted bookmark' });

    await messages.handlers.dismissTimedMessage.run({ messageId: stale }, client);
    expect(messages.current(1)?.id).toBe(messageId);

    await messages.handlers.dismissTimedMessage.run({ messageId }, client);
    expect(messages.current(1)).toBeUndefined();
    await expect(messages.handlers.actOnTimedMessage.run({ messageId }, client)).rejects.toThrow('expired');
    expect(act).not.toHaveBeenCalled();
  });

  it('never acts on another window\'s message', async () => {
    const { messages } = install();
    const act = vi.fn(async () => undefined);
    const messageId = messages.offer(2, { act, kind: 'undo', text: 'Moved bookmark' });

    await expect(messages.handlers.actOnTimedMessage.run({ messageId }, client)).rejects.toThrow('expired');
    expect(act).not.toHaveBeenCalled();
  });

  it('reports a failed action as an error the user can copy', async () => {
    const { messages } = install();
    const messageId = messages.offer(1, {
      act: async () => { throw new Error('The folder is gone.'); },
      kind: 'undo',
      text: 'Deleted folder',
    });

    await expect(messages.handlers.actOnTimedMessage.run({ messageId }, client)).rejects.toThrow('gone');

    expect(messages.current(1)).toMatchObject({ kind: 'feedback', text: 'The folder is gone.', tone: 'error' });
  });

  it('starts a gesture offer as the press is admitted, while it still counts as a gesture', async () => {
    const { messages } = install();
    const act = vi.fn(async () => undefined);
    const messageId = messages.offer(1, { act, gesture: true, kind: 'opt-in', text: 'Fix play/pause?' });
    const handler = messages.handlers.actOnTimedMessage;

    const started = handler.admit!({ messageId }, client);

    expect(act).toHaveBeenCalledOnce();
    expect(messages.current(1)).toBeUndefined();
    await handler.run({ messageId }, client, undefined, started);
    expect(act).toHaveBeenCalledOnce();
  });

  it('reports a gesture offer that failed and fails its command', async () => {
    const { messages } = install();
    const messageId = messages.offer(1, {
      act: async () => { throw new Error('Hyper was not allowed on example.test.'); },
      gesture: true,
      kind: 'opt-in',
      text: 'Fix play/pause?',
    });
    const handler = messages.handlers.actOnTimedMessage;

    const started = handler.admit!({ messageId }, client);

    await expect(handler.run({ messageId }, client, undefined, started)).rejects.toThrow('not allowed');
    expect(messages.current(1)).toMatchObject({
      kind: 'feedback',
      text: 'Hyper was not allowed on example.test.',
      tone: 'error',
    });
  });

  it('leaves an ordinary offer, or an expired one, for its turn on the lane', () => {
    const { messages } = install();
    const act = vi.fn(async () => undefined);
    const ordinary = messages.offer(1, { act, kind: 'undo', text: 'Moved tab' });
    const handler = messages.handlers.actOnTimedMessage;

    expect(handler.admit!({ messageId: ordinary }, client)).toBeUndefined();
    messages.offer(1, { act, gesture: true, kind: 'opt-in', text: 'Fix play/pause?' });
    expect(handler.admit!({ messageId: ordinary }, client)).toBeUndefined();
    expect(act).not.toHaveBeenCalled();
  });

  it('takes feedback from a view only with text and a known tone', async () => {
    const { messages } = install();

    await messages.handlers.showMessage.run({ text: '  Saved  ', tone: 'warning' }, client);

    expect(messages.current(1)).toMatchObject({ kind: 'feedback', text: 'Saved', tone: 'warning' });
    expect(() => messages.handlers.showMessage.targets({ text: ' ', tone: 'info' }, client)).toThrow();
    expect(() => messages.handlers.showMessage.targets({ text: 'Hi', tone: 'loud' }, client)).toThrow();
  });

  it('drops a message about a tab once that tab closes or leaves its window', () => {
    const { messages } = install();
    messages.offer(1, { act: async () => undefined, kind: 'opt-in', tabId: 5, text: 'Deduplicate?' });
    const message = messages.current(1) as TimedMessage;
    const unbound = { ...message, tabId: undefined };

    expect(currentTimedMessages([{ id: 5, windowId: 1 }], { 1: message, 3: message, 4: unbound }))
      .toEqual({ 1: message, 4: unbound });
    messages.removeTab(5);
    expect(messages.current(1)).toBeUndefined();
  });
});
