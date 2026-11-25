import { describe, expect, it, vi } from 'vitest';
import { createWindowSpaceChoice } from './windowSpaceChoice';

const sidebar = { role: 'sidebar', windowId: 3 };
const newTab = { role: 'newtab', windowId: 3 };

function setup(parked = false) {
  const runtime = {
    activeSpaceIds: { 3: 'work' } as Record<number, string>,
    tabOwnerships: { 7: { spaceId: 'home' }, 8: { spaceId: 'work' } },
  };
  const switcher = {
    admit: vi.fn(),
    runIfLatest: vi.fn(async (_windowId: number, _spaceId: string, run: () => Promise<void>) => run()),
    select: vi.fn(async () => undefined),
  };
  const activateFromSearch = vi.fn(async () => undefined);
  const choice = createWindowSpaceChoice({
    activateFromSearch,
    hasParkedTabs: async () => parked,
    model: () => ({ runtime }) as never,
    queueMutation: (operation) => operation(),
    switcher,
  });
  return { activateFromSearch, choice, switcher };
}

describe('window space choice', () => {
  it('admits and switches before a page that opens in another space, with no blank tab', async () => {
    const { choice, switcher } = setup();
    const page = { active: true, destinationSpaceId: 'home' };

    choice.beforePage(page, sidebar).admit();
    await choice.beforePage(page, sidebar).run();

    expect(switcher.admit).toHaveBeenCalledWith(3, 'home');
    expect(switcher.select).toHaveBeenCalledWith('home', 3, { blankTab: false, reconcile: false });
  });

  it('leaves the window alone for a page in its own space or one opened in the background', async () => {
    const { choice, switcher } = setup();

    for (const page of [
      { active: true, destinationSpaceId: 'work' },
      { active: false, destinationSpaceId: 'home' },
      { active: true },
    ]) {
      choice.beforePage(page, sidebar).admit();
      await choice.beforePage(page, sidebar).run();
    }

    expect(switcher.admit).not.toHaveBeenCalled();
    expect(switcher.select).not.toHaveBeenCalled();
  });

  it('takes a sidebar to the space of a tab it focuses there, and no other view', async () => {
    const { choice, switcher } = setup();

    await choice.beforeTab(7, sidebar).run();
    await choice.beforeTab(8, sidebar).run();
    await choice.beforeTab(7, newTab).run();

    expect(switcher.select).toHaveBeenCalledTimes(1);
    expect(switcher.select).toHaveBeenCalledWith('home', 3, { blankTab: false, reconcile: false });
  });

  it('gives a search view the light activation unless parked tabs need a full switch', async () => {
    const light = setup();
    await light.choice.switchTo('home', newTab);
    expect(light.activateFromSearch).toHaveBeenCalledWith('home', 3);
    expect(light.switcher.select).not.toHaveBeenCalled();

    const parked = setup(true);
    await parked.choice.switchTo('home', newTab);
    expect(parked.switcher.select).toHaveBeenCalledWith('home', 3, { blankTab: undefined, reconcile: false });
    expect(parked.activateFromSearch).not.toHaveBeenCalled();
  });

  it('shows a new space with a full switch that may take the focused new tab page', async () => {
    const { activateFromSearch, choice, switcher } = setup();

    await choice.showNewSpace('home', sidebar);

    expect(switcher.runIfLatest).toHaveBeenCalledWith(3, 'home', expect.any(Function));
    expect(switcher.select).toHaveBeenCalledWith('home', 3, { reconcile: false, takeNewTab: true });
    expect(activateFromSearch).not.toHaveBeenCalled();
  });
});
