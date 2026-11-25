import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNewTabDisposal } from './newTabDisposal';

vi.mock('./spaceGroupStore', () => ({ spaceGroupId: vi.fn(async () => 7) }));
vi.mock('./tabOwnership', () => ({ getTabOwnership: vi.fn(async () => undefined) }));

const newTabUrl = 'chrome-extension://hyper/newtab.html';
const tab = (id: number, groupId: number, url: string, pinned = false) =>
  ({ groupId, id, pinned, url, windowId: 3 }) as Browser.tabs.Tab;

afterEach(() => vi.unstubAllGlobals());

describe('new tab disposal', () => {
  it('closes only the left space\'s untouched blank tabs, and nothing once superseded', async () => {
    const tabs = [
      tab(1, 7, newTabUrl),
      tab(2, 8, 'about:blank'),
      tab(3, 7, 'about:blank', true),
      tab(4, 7, 'https://example.test/'),
    ];
    const remove = vi.fn(async () => undefined);
    vi.stubGlobal('browser', {
      tabs: {
        get: vi.fn(async (tabId: number) => tabs.find((candidate) => candidate.id === tabId)),
        query: vi.fn(async () => tabs),
        remove,
      },
    });
    const disposal = createNewTabDisposal({
      activationTokens: new Map([[3, 'current']]),
      generations: new Map(),
      markIntentionalTab: vi.fn(),
      newTabUrl,
    });

    await disposal.disposeSpaceNewTabs('space', 3, 'superseded');
    expect(remove).not.toHaveBeenCalled();

    await disposal.disposeSpaceNewTabs('space', 3, 'current');
    expect(remove).toHaveBeenCalledWith([1]);
  });
});
