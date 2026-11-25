import { describe, expect, it, vi } from 'vitest';
import { createFavouriteBarActions } from './favouriteBarActions';

const setup = (favouritesFolderId: string | null = 'favourites') => {
  const browserState = {
    addTabBookmark: vi.fn(async () => undefined),
    closeTabs: vi.fn(async () => undefined),
    favouritesFolderId,
    focusTab: vi.fn(async () => undefined),
    openFavourite: vi.fn(async () => undefined),
    submitSelection: vi.fn(async () => []),
    updateBookmark: vi.fn(async () => undefined),
  };
  const showNotice = vi.fn();
  const showTabs = vi.fn();
  const actions = createFavouriteBarActions({
    browserState,
    clearSelectedTabsAfter: (operation) => operation,
    onUnpin: vi.fn(),
    showNotice,
    showTabs,
  });
  return { actions, browserState, showNotice, showTabs };
};

describe('favourites bar actions', () => {
  it('shows the tabs list when a tile focuses or opens a tab', () => {
    const { actions, browserState, showTabs } = setup();
    actions.onFocusTab({ id: 4 } as never);
    expect(showTabs).toHaveBeenCalledTimes(1);
    actions.onOpen('https://example.com/', false);
    expect(showTabs).toHaveBeenCalledTimes(2);
    expect(browserState.openFavourite).toHaveBeenCalledWith('https://example.com/', false);
  });

  it('unpins a grouped tile\'s favourites as one selection', () => {
    const { actions, browserState } = setup();
    const node = (id: string) => ({ id, syncing: false, title: id });
    actions.onUnpinMany([node('one'), node('two')]);
    expect(browserState.submitSelection).toHaveBeenCalledWith('deleteBookmark', [
      { bookmarkId: 'one', unpin: true },
      { bookmarkId: 'two', unpin: true },
    ]);
  });

  it('pins a tab into its slot of the favourites folder', () => {
    const { actions, browserState } = setup();
    actions.onPin(7, 3);
    expect(browserState.addTabBookmark).toHaveBeenCalledWith('favourites', 7, undefined, 3);
  });

  it('says why a tab cannot be pinned before favourites exist', () => {
    const { actions, browserState, showNotice } = setup(null);
    actions.onPin(7, 3);
    expect(browserState.addTabBookmark).not.toHaveBeenCalled();
    expect(showNotice).toHaveBeenCalledWith('Favourites are not ready yet', 'warning');
  });

  it('reports a failure over the favourites bar', async () => {
    const { actions, browserState, showNotice } = setup();
    browserState.closeTabs.mockRejectedValueOnce(new Error('Gone'));
    actions.onCloseTabs([1, 2]);
    await vi.waitFor(() => expect(showNotice).toHaveBeenCalledWith('Gone'));
    expect(browserState.closeTabs).toHaveBeenCalledWith([1, 2]);
  });
});
