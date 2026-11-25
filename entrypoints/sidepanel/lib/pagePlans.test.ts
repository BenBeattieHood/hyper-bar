import { describe, expect, it, vi } from 'vitest';
import { carryOutPagePlan } from './pagePlans';

const page = (url: string) => ({ title: url, url });

const created = (value: boolean) => ({ created: value, node: { id: 'b', title: 'B' } });

const dependencies = (results: unknown[] = [created(true)]) => {
  const submitSelection = vi.fn(async (_kind: string, _payloads: unknown[]) => results);
  const showNotice = vi.fn();
  return { activeSpaceId: 'active', browserState: { submitSelection } as never, showNotice, submitSelection };
};

describe('page plans', () => {
  it('bookmarks pages in order from where they go, each into its favourite slot', async () => {
    const run = dependencies();
    await carryOutPagePlan({
      favouriteSlots: [4, 1],
      index: 2,
      kind: 'bookmark-pages',
      notice: 'Added',
      pages: [page('https://a.example/'), page('https://b.example/')],
      parentId: 'folder',
    }, run);
    expect(run.submitSelection).toHaveBeenCalledExactlyOnceWith('createBookmark', [
      { favouriteSlot: 4, index: 2, page: page('https://a.example/'), parentId: 'folder' },
      { favouriteSlot: 1, index: 3, page: page('https://b.example/'), parentId: 'folder' },
    ]);
    expect(run.showNotice).toHaveBeenCalledExactlyOnceWith('Added', 'info');
  });

  it('says when every page was already bookmarked there', async () => {
    const one = dependencies([created(false)]);
    await carryOutPagePlan({ kind: 'bookmark-pages', pages: [page('https://a.example/')], parentId: 'f' }, one);
    expect(one.submitSelection.mock.calls[0]?.[1]).toEqual([{ page: page('https://a.example/'), parentId: 'f' }]);
    expect(one.showNotice).toHaveBeenCalledWith('That page is already bookmarked here', 'warning');

    const two = dependencies([created(false), created(false)]);
    await carryOutPagePlan({
      kind: 'bookmark-pages',
      notice: 'Added',
      pages: [page('https://a.example/'), page('https://b.example/')],
      parentId: 'f',
    }, two);
    expect(two.showNotice).toHaveBeenCalledExactlyOnceWith('Those pages are already bookmarked here', 'warning');
  });

  it('opens pages as new tabs, bringing a single one to the front only when asked', async () => {
    const single = dependencies();
    await carryOutPagePlan({ activate: true, kind: 'open-pages', pages: [page('https://a.example/')], spaceId: 's2' }, single);
    expect(single.submitSelection).toHaveBeenCalledWith('openBookmark', [{
      active: true,
      destinationSpaceId: 's2',
      forceNew: true,
      reuse: 'browser',
      url: 'https://a.example/',
    }]);

    const many = dependencies();
    await carryOutPagePlan({
      activate: true,
      kind: 'open-pages',
      pages: [page('https://a.example/'), page('https://b.example/')],
    }, many);
    expect(many.submitSelection.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({ active: false, destinationSpaceId: 'active', url: 'https://a.example/' }),
      expect.objectContaining({ active: false, destinationSpaceId: 'active', url: 'https://b.example/' }),
    ]);
  });
});
