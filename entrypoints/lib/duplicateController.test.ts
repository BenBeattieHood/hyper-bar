import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  allowsDuplicate,
  createDuplicateController,
  duplicateOriginal,
  newTabOrigin,
} from './duplicateController';
import type { HyperModelPortClient } from './modelPort';
import type { TabOwnership } from './tabOwnership';
import { createTimedMessages, DEFAULT_TIMED_MESSAGE_MS } from './timedMessages';

const client: HyperModelPortClient = { clientId: 'sidebar', role: 'sidebar', windowId: 1 };
const queueMutation = <Result,>(operation: () => Promise<Result>) => operation();

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('new tab origins', () => {
  const facts = {
    copiedOwnership: false,
    intentional: false,
    newTabUrl: 'chrome-extension://hyper/newtab.html',
    restored: false,
    tab: { active: true, pendingUrl: 'https://example.com/page', url: '' },
  };
  const opened = (tab: { active?: boolean; openerTabId?: number; pendingUrl?: string; url?: string }) =>
    ({ ...facts, tab: { ...facts.tab, ...tab } });

  it('allows the copies a user asks for and dedupes the rest', () => {
    expect(newTabOrigin({ ...facts, copiedOwnership: true, restored: true })).toBe('duplicate');
    expect(newTabOrigin(opened({ active: false, openerTabId: 4 }))).toBe('background-link');
    expect(newTabOrigin(facts)).toBe('external');
    expect(newTabOrigin(opened({ openerTabId: 4 }))).toBe('foreground-link');
    expect(newTabOrigin(opened({ pendingUrl: facts.newTabUrl }))).toBe('blank');
    expect(newTabOrigin({ ...facts, restored: true })).toBe('restored');
    expect(newTabOrigin({ ...facts, copiedOwnership: true, intentional: true })).toBe('hyper');
    expect(['duplicate', 'background-link', 'external'].every((origin) =>
      allowsDuplicate(origin as Parameters<typeof allowsDuplicate>[0]))).toBe(true);
    expect(['foreground-link', 'blank', 'restored', 'hyper'].some((origin) =>
      allowsDuplicate(origin as Parameters<typeof allowsDuplicate>[0]))).toBe(false);
  });

  it("tells Chromium's Duplicate, which arrives showing its page, from a page's link", () => {
    const duplicated = { openerTabId: 4, url: 'https://example.com/page' };
    expect(newTabOrigin(opened(duplicated))).toBe('duplicate');
    expect(newTabOrigin(opened({ ...duplicated, active: false }))).toBe('duplicate');
    expect(newTabOrigin(opened({ openerTabId: 4, url: 'about:blank' }))).toBe('foreground-link');
    expect(newTabOrigin(opened({ openerTabId: 4, url: facts.newTabUrl }))).toBe('foreground-link');
  });
});

describe('duplicate originals', () => {
  const owned = (id: number, url: string, windowId = 1, spaceId = 'green') => ({
    ownership: { spaceId },
    tab: { id, url, windowId },
  });

  it('only pairs tabs of the same space and window showing the same page', () => {
    const subject = owned(9, 'https://example.com/page#later');
    expect(duplicateOriginal(subject, [
      subject,
      owned(3, 'https://example.com/page', 2),
      owned(4, 'https://example.com/page', 1, 'blue'),
      owned(5, 'https://example.com/other'),
    ])).toBeUndefined();
    expect(duplicateOriginal(subject, [
      owned(7, 'https://example.com/page'),
      owned(6, 'https://example.com/page'),
      subject,
    ])?.id).toBe(6);
    expect(duplicateOriginal({ tab: subject.tab }, [owned(6, 'https://example.com/page')]))
      .toBeUndefined();
    // A newer tab that reached the page first is the copy, not the original.
    expect(duplicateOriginal(subject, [owned(10, 'https://example.com/page')])).toBeUndefined();
  });

  it('counts a different query as a different page', () => {
    const frame = owned(9, 'https://example.com/file?node-id=1');
    expect(duplicateOriginal(frame, [owned(6, 'https://example.com/file?node-id=2')]))
      .toBeUndefined();
    expect(duplicateOriginal(frame, [owned(6, 'https://example.com/file/?node-id=1')])?.id)
      .toBe(6);
  });
});

describe('duplicate controller', () => {
  const install = (tabs: Array<Browser.tabs.Tab & { id: number }>) => {
    const ownerships = new Map<number, TabOwnership>(
      tabs.map((tab) => [tab.id, { backingId: `backing-${tab.id}`, spaceId: 'green' }]),
    );
    const remove = vi.fn(async (tabId: number) => {
      tabs.splice(tabs.findIndex((tab) => tab.id === tabId), 1);
    });
    const update = vi.fn(async () => undefined);
    vi.stubGlobal('browser', {
      tabs: {
        get: async (tabId: number) => tabs.find((tab) => tab.id === tabId),
        query: async ({ windowId }: { windowId: number }) =>
          tabs.filter((tab) => tab.windowId === windowId),
        remove,
        update,
      },
    });
    const messages = createTimedMessages({ now: () => 1_000, reconcile: async () => undefined });
    const controller = createDuplicateController({
      getTabOwnership: async (tabId) => ownerships.get(tabId),
      messages,
      now: () => 1_000,
      queueMutation,
    });
    return { controller, messages, remove, update };
  };
  const tab = (id: number, active = false, windowId = 1) => ({
    active,
    id,
    incognito: false,
    url: 'https://example.com/page',
    windowId,
  }) as Browser.tabs.Tab & { id: number };

  it('offers the window of an allowed copy a brief opt-in dedupe', async () => {
    vi.useFakeTimers();
    const { controller, messages } = install([tab(1), tab(2, true)]);

    await expect(controller.allow(2)).resolves.toBe(true);

    expect(messages.current(1)).toMatchObject({
      durationMs: DEFAULT_TIMED_MESSAGE_MS,
      expiresAt: 1_000 + DEFAULT_TIMED_MESSAGE_MS,
      kind: 'opt-in',
      tabId: 2,
      text: 'Deduplicate?',
    });
    vi.advanceTimersByTime(DEFAULT_TIMED_MESSAGE_MS);
    expect(messages.current(1)).toBeUndefined();
  });

  it('never offers a dedupe across windows', async () => {
    const { controller, messages } = install([tab(1, false, 2), tab(2, true)]);

    await expect(controller.allow(2)).resolves.toBe(false);

    expect(messages.runtimeSignals().timedMessages).toEqual({});
  });

  it('keeps a new tab a candidate through its first load and redirects only', async () => {
    const { controller } = install([tab(1)]);
    const commit = (url: string, transitionQualifiers: string[] = [], frameId = 0) =>
      controller.noteCommit({ frameId, tabId: 1, transitionQualifiers, url });

    // The first commit may arrive before the tab is marked.
    commit('https://example.com/start');
    controller.markCandidate(1);
    commit('https://example.com/page', ['client_redirect']);
    commit('https://frame.example.com/', [], 3);
    await expect(controller.isCandidateAt(1, 'https://example.com/page')).resolves.toBe(true);

    const typed = controller.isCandidateAt(1, 'https://example.com/typed');
    commit('https://example.com/typed', ['from_address_bar']);
    await expect(typed).resolves.toBe(false);

    const safeLinks = 'https://teams.public.onecdn.static.microsoft/evergreen-assets/safelinks/2/atp-safelinks.html';
    expect(controller.restartAtWrapperPage(1, 'https://example.com/typed')).toBe(false);
    expect(controller.isCandidate(1)).toBe(false);
    expect(controller.restartAtWrapperPage(1, `${safeLinks}?url=x`)).toBe(true);
    commit(safeLinks);
    commit('https://example.com/destination', ['client_redirect']);
    expect(controller.isCandidate(1)).toBe(true);
  });

  it('ends a candidate whose first load was abandoned for another page', () => {
    const { controller } = install([tab(1)]);
    controller.markCandidate(1, 'https://example.com/opened');

    // The abandoned load errors as aborted, which is not counted.
    controller.noteCommit({ frameId: 0, tabId: 1, url: 'https://example.com/elsewhere' });

    expect(controller.isCandidate(1)).toBe(false);
  });

  it('dedupes by closing the copy and showing its original once its tick is pressed', async () => {
    const { controller, messages, remove, update } = install([tab(1), tab(2, true)]);
    await controller.allow(2);
    const messageId = messages.current(1)!.id;

    await messages.handlers.actOnTimedMessage.run({ messageId }, client);

    expect(update).toHaveBeenCalledWith(1, { active: true });
    expect(remove).toHaveBeenCalledWith(2);
    expect(messages.current(1)).toBeUndefined();
    await expect(messages.handlers.actOnTimedMessage.run({ messageId }, client))
      .rejects.toThrow('expired');
  });

  it('reports a dedupe that no longer applies instead of closing anything', async () => {
    const tabs = [tab(1), tab(2, true)];
    const { controller, messages, remove } = install(tabs);
    await controller.allow(2);
    const messageId = messages.current(1)!.id;
    tabs[0]!.url = 'https://example.com/elsewhere';

    await expect(messages.handlers.actOnTimedMessage.run({ messageId }, client))
      .rejects.toThrow('no longer duplicates');

    expect(remove).not.toHaveBeenCalled();
    expect(messages.current(1)).toMatchObject({ kind: 'feedback', tone: 'error' });
  });
});
