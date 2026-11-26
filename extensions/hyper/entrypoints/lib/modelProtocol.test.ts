import { describe, expect, it } from 'vitest';
import {
  HYPER_MODEL_PROTOCOL_VERSION,
  createDeliveryCursor,
  parseClientMessage,
} from './modelProtocol';

describe('client message parsing', () => {
  it('accepts a versioned hello and rejects any other version', () => {
    expect(parseClientMessage({
      protocolVersion: HYPER_MODEL_PROTOCOL_VERSION,
      role: 'sidebar',
      type: 'hello',
      windowId: 3,
    })).toEqual({
      message: {
        protocolVersion: HYPER_MODEL_PROTOCOL_VERSION,
        role: 'sidebar',
        type: 'hello',
        windowId: 3,
      },
      status: 'parsed',
    });
    expect(parseClientMessage({
      protocolVersion: HYPER_MODEL_PROTOCOL_VERSION + 1,
      role: 'sidebar',
      type: 'hello',
    })).toEqual({ reason: 'unsupported-protocol-version', status: 'rejected' });
  });

  it('rejects malformed and unknown messages before any handler sees them', () => {
    expect(parseClientMessage(null)).toEqual({
      reason: 'malformed-message',
      status: 'rejected',
    });
    expect(parseClientMessage({ type: 'ack' })).toEqual({
      reason: 'malformed-message',
      status: 'rejected',
    });
    expect(parseClientMessage({ type: 'shutdown' })).toEqual({
      reason: 'unknown-message',
      status: 'rejected',
    });
  });

  it('requires an intent to name its command and the revision it was decided on', () => {
    expect(parseClientMessage({
      baseRevision: 4,
      commandId: 'command-1',
      kind: 'closeTabs',
      payload: { tabIds: [1] },
      type: 'intent',
    }).status).toBe('parsed');
    expect(parseClientMessage({
      commandId: 'command-1',
      kind: 'closeTabs',
      type: 'intent',
    }).status).toBe('rejected');
  });

  it.each([
    { baseRevision: Number.NaN, commandId: 'command-1', kind: 'closeTabs' },
    { baseRevision: -1, commandId: 'command-1', kind: 'closeTabs' },
    { baseRevision: 4, commandId: '', kind: 'closeTabs' },
    { baseRevision: 4, commandId: 'x'.repeat(129), kind: 'closeTabs' },
    { baseRevision: 4, commandId: 'command-1', kind: 'toString' },
    { baseRevision: 4, commandId: 'command-1', kind: 'notAnAction' },
  ])('rejects an intent with an unusable revision, command id or kind: %o', (fields) => {
    expect(parseClientMessage({ ...fields, type: 'intent' })).toEqual({
      reason: 'malformed-message',
      status: 'rejected',
    });
  });

  it('accepts only bounded presentation commands in a correlated search query', () => {
    expect(parseClientMessage({
      commands: [{ detail: 'Hyper', icon: 'settings', id: 'settings', label: 'Open settings' }],
      includeFolders: false,
      limit: 18,
      query: 'settings',
      requestId: 'query-1',
      type: 'search-query',
    })).toMatchObject({
      message: { requestId: 'query-1', type: 'search-query' },
      status: 'parsed',
    });
    expect(parseClientMessage({
      commands: [{ detail: 'Hyper', icon: 'settings', id: 'settings', label: 'Open settings' }],
      limit: 0,
      query: 'settings',
      requestId: 'query-1',
      type: 'search-query',
    })).toEqual({ reason: 'malformed-message', status: 'rejected' });
    expect(parseClientMessage({
      commands: [{ id: 'settings' }],
      query: 'settings',
      requestId: 'query-1',
      type: 'search-query',
    })).toEqual({ reason: 'malformed-message', status: 'rejected' });
  });

  it('accepts a command naming the tab it acts on only by a tab id', () => {
    const query = (tabId: unknown) => parseClientMessage({
      commands: [{ detail: 'Radio', icon: 'pause', id: 'media:pause', label: 'Pause music', tabId }],
      query: 'pause',
      requestId: 'query-1',
      type: 'search-query',
    });
    expect(query(7)).toMatchObject({
      message: { commands: [{ id: 'media:pause', tabId: 7 }] },
      status: 'parsed',
    });
    for (const tabId of ['7', -1, 1.5, null]) {
      expect(query(tabId)).toEqual({ reason: 'malformed-message', status: 'rejected' });
    }
  });
});

describe('delivery cursor', () => {
  it('keeps a single delivery in flight and coalesces the revisions behind it', () => {
    const cursor = createDeliveryCursor();
    expect(cursor.offer(1)).toEqual({ revision: 1, sequence: 1 });
    expect(cursor.offer(2)).toBeUndefined();
    expect(cursor.offer(3)).toBeUndefined();
    expect(cursor.ack(1)).toEqual({
      deliver: { revision: 3, sequence: 2 },
      status: 'accepted',
    });
    expect(cursor.acknowledgedRevision()).toBe(1);
    expect(cursor.ack(2)).toEqual({ status: 'accepted' });
    expect(cursor.acknowledgedRevision()).toBe(3);
  });

  it('rejects an acknowledgement that does not match the delivery in flight', () => {
    const cursor = createDeliveryCursor();
    cursor.offer(1);
    expect(cursor.ack(7)).toEqual({ reason: 'unexpected-ack', status: 'rejected' });
    expect(cursor.ack(1).status).toBe('accepted');
    expect(cursor.ack(1)).toEqual({ reason: 'unexpected-ack', status: 'rejected' });
  });

  it('does not redeliver a revision the client has already acknowledged', () => {
    const cursor = createDeliveryCursor();
    cursor.offer(5);
    cursor.offer(5);
    expect(cursor.ack(1)).toEqual({ status: 'accepted' });
  });

  it('forgets the acknowledged base on resync so the next send is a full one', () => {
    const cursor = createDeliveryCursor();
    cursor.offer(1);
    cursor.ack(1);
    cursor.reset();
    expect(cursor.acknowledgedRevision()).toBeUndefined();
    expect(cursor.offer(4)).toEqual({ revision: 4, sequence: 2 });
  });
});
