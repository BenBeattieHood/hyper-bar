import { expect, test } from '@playwright/test';
import { withHyper } from './helpers/extension';
import { createTab, activeTabId } from './helpers/tabs';
import { tabRowSelector } from './helpers/rows';

// The list moves under a pointer that holds still as it scrolls to the active
// tab, or as a row above tweens in or out. A press and release on the same row
// are still a click on it.
test('a tab row the list scrolls under a still pointer still takes the click', async () => {
  await withHyper('row-click', async ({ page: sidebar, worker }) => {
    // Short enough that the rows and the New tab row overflow the list.
    await sidebar.setViewportSize({ width: 1280, height: 300 });
    const tabId = await createTab(worker, 'https://space-race.test/one');
    await createTab(worker, 'https://space-race.test/two');
    await sidebar.bringToFront();

    const list = sidebar.locator('.tabs-drop-zone');
    const row = sidebar.locator(
      `${tabRowSelector(tabId)} .tab-main`,
    );
    await expect.poll(() => list.evaluate((zone) => zone.scrollHeight - zone.clientHeight))
      .toBeGreaterThan(4);
    // From the top of the list, once the row has stopped moving and takes a
    // press at its centre.
    await expect.poll(() => row.evaluate(async (main) => {
      const zone = main.closest('.tabs-drop-zone');
      if (!zone) return false;
      zone.scrollTop = 0;
      const tops: number[] = [];
      for (let frame = 0; frame < 20; frame += 1) {
        await new Promise((settled) => requestAnimationFrame(settled));
        tops.push(main.getBoundingClientRect().top);
      }
      const box = main.getBoundingClientRect();
      return zone.scrollTop === 0 && tops.every((top) => top === box.top) &&
        main.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
    })).toBe(true);
    const before = await row.boundingBox();
    if (!before) throw new Error('Tab row was not measurable');
    expect(await activeTabId(worker)).not.toBe(tabId);

    await sidebar.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await sidebar.mouse.down();
    await list.evaluate((zone) => new Promise<void>((settled) => {
      zone.scrollTop += 2;
      requestAnimationFrame(() => settled());
    }));
    expect((await row.boundingBox())?.y).toBeCloseTo(before.y - 2, 1);
    await sidebar.mouse.up();

    await expect.poll(() => activeTabId(worker)).toBe(tabId);
  });
});
