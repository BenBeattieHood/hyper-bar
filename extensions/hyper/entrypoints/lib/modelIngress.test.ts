import { describe, expect, it } from 'vitest';
import {
  envelope,
  ingressInventory,
  ingressNames,
  ingressRoute,
  isModelStorageArea,
} from './modelIngress';

describe('ingress inventory', () => {
  it('routes every named ingress onto a known lane', () => {
    const unrouted = ingressNames.filter(
      (name) => !['intent', 'lifecycle', 'reconcile'].includes(
        ingressInventory[name].route,
      ),
    );
    expect(unrouted).toEqual([]);
  });

  it('reconciles background-owned history metadata into the model revision', () => {
    expect(ingressRoute('history.onTitleChanged')).toBe('reconcile');
    expect(ingressRoute('history.onVisited')).toBe('reconcile');
    expect(ingressRoute('history.onVisitRemoved')).toBe('reconcile');
  });

  it('names the ingresses that are easy to forget', () => {
    for (const name of [
      'bookmarks.onChildrenReordered',
      'bookmarks.onImportEnded',
      'commands.onCommand',
      'model.structureDegraded',
      'permissions.onAdded',
      'permissions.onRemoved',
      'sessions.onChanged',
      'storage.onChanged',
    ] as const) {
      expect(ingressInventory[name]).toBeDefined();
    }
  });

  it('treats user initiated surfaces as intents and worker boundaries as lifecycle', () => {
    expect(ingressRoute('commands.onCommand')).toBe('intent');
    expect(ingressRoute('action.onClicked')).toBe('intent');
    expect(ingressRoute('runtime.onMessage')).toBe('intent');
    expect(ingressRoute('runtime.onStartup')).toBe('lifecycle');
    expect(ingressRoute('port.onConnect')).toBe('lifecycle');
    expect(ingressRoute('tabs.onCreated')).toBe('reconcile');
  });

  it('declares the storage areas that carry model state in exactly one place', () => {
    expect(isModelStorageArea('local')).toBe(true);
    expect(isModelStorageArea('session')).toBe(true);
    expect(isModelStorageArea('sync')).toBe(false);
    expect(isModelStorageArea('managed')).toBe(false);
  });

  it('stamps an envelope with the route its ingress declares', () => {
    expect(envelope('id-1', 'tabs.onMoved', 'browser', 42, { tabId: 3 })).toEqual({
      id: 'id-1',
      ingress: 'tabs.onMoved',
      observedAt: 42,
      payload: { tabId: 3 },
      route: 'reconcile',
      source: 'browser',
    });
  });
});
