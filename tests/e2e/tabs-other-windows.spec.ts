import { expect, test, type Locator, type Page } from '@playwright/test';
import { paintedCustomProperty } from './fixtures/styles';
import { callChrome } from './helpers/chrome';
import {
  extensionBaseUrl,
  openPlainSidebar,
  pinExtensionHost,
  routePathTitles,
  withExtension,
} from './helpers/extension';
import { selectSpace } from './helpers/sidebar';
import { createSecondSpace, waitForTabSpaceGroup } from './helpers/spaces';
import { closeWindow, createTab, queryTabs } from './helpers/tabs';

const page = (path: string) => `https://other-windows.test/${path}`;

const box = async (locator: Locator) => {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error('The element was not measurable');
  return bounds;
};

/** The footnote sits at the very bottom of the tab list, below its last row, inset 12px each side, its text within it. */
async function expectAtListBottom(line: Locator, lastRow: Locator, zone: Locator) {
  await expect(async () => {
    const [lineBox, rowBox, zoneBox, zonePadding, overflows] = await Promise.all([
      box(line),
      box(lastRow),
      box(zone),
      zone.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          bottom: parseFloat(style.paddingBottom),
          left: parseFloat(style.paddingLeft),
          right: parseFloat(style.paddingRight),
        };
      }),
      line.evaluate((element) => element.scrollWidth > element.clientWidth),
    ]);
    expect(lineBox.y).toBeGreaterThan(rowBox.y + rowBox.height);
    expect(zoneBox.y + zoneBox.height - zonePadding.bottom - (lineBox.y + lineBox.height)).toBeCloseTo(0, 0);
    expect(lineBox.x).toBeCloseTo(zoneBox.x + zonePadding.left + 12, 0);
    expect(lineBox.width).toBeCloseTo(zoneBox.width - zonePadding.left - zonePadding.right - 24, 0);
    expect(overflows).toBe(false);
  }).toPass({ timeout: 3000 });
}

async function screenshots(sidebar: Page, name: string) {
  for (const colorScheme of ['light', 'dark'] as const) {
    await sidebar.emulateMedia({ colorScheme });
    // Let the colour transitions finish before capturing.
    await sidebar.waitForTimeout(400);
    await sidebar.screenshot({ path: `logs/tabs-other-windows-${name}-${colorScheme}.png` });
  }
  await sidebar.emulateMedia({ colorScheme: 'light' });
}

test('ends the tabs list with a count of the space\'s tabs open in other windows', async () => {
  await withExtension('tabs-other-windows', async ({ context, worker }) => {
    await routePathTitles(context, 'https://other-windows.test/**');
    const { sidebar, windowId } = await openPlainSidebar(context, worker);
    // Pinned, the sidebar stays shown while its window changes space.
    await pinExtensionHost(worker, extensionBaseUrl(worker));
    // The space the sidebar shows, whose layer a space switch slides out beside the next one.
    const spaceId = await sidebar.locator('.tabs-space-layer').getAttribute('data-space-id');
    if (!spaceId) throw new Error('The sidebar shows no space');
    const tabsLayer = sidebar.locator(`.tabs-space-layer[data-space-id="${spaceId}"]`);
    const lastRow = tabsLayer.locator('.tab-row').last();
    const zone = tabsLayer.locator('.tabs-drop-zone');
    const line = tabsLayer.locator('.tabs-other-windows');

    // This window's own tabs are its list, not the count.
    await createTab(worker, page('here'), { active: false, windowId });
    await expect(tabsLayer.locator(`.tab-main[data-url="${page('here')}"]`)).toBeVisible();
    await expect(line).toHaveCount(0);

    // Another window shows the space with a page and a blank new tab, and both count.
    const created = await callChrome<{ id?: number; tabs?: Array<{ id?: number }> }>(
      worker,
      'windows.create',
      { focused: false, url: page('there') },
    );
    const otherWindowId = created.id;
    const pageTabId = created.tabs?.[0]?.id;
    if (otherWindowId === undefined || pageTabId === undefined) throw new Error('The other window was not created');
    await waitForTabSpaceGroup(worker, pageTabId, spaceId);
    const blankTabId = await createTab(worker, 'chrome://newtab/', { windowId: otherWindowId });
    await expect.poll(async () => (await queryTabs(worker, { windowId: otherWindowId })).length).toBe(2);
    await expect(line).toHaveText('+2 open in other windows');
    await expect(line).toHaveAttribute('title', '2 tabs from this space are open in other windows');

    // A quiet footnote at the very bottom of the list, centred in the list.
    await expect(line).toHaveCSS('color', await paintedCustomProperty(line, '--faint'));
    await expect(line).toHaveCSS('font-size', '10px');
    await expectAtListBottom(line, lastRow, zone);
    await sidebar.mouse.move(0, 0);
    await screenshots(sidebar, 'wide');

    // The count follows the other window's tabs as they close.
    await callChrome(worker, 'tabs.remove', blankTabId);
    await expect(line).toHaveText('+1 open in other windows');
    await expect(line).toHaveAttribute('title', '1 tab from this space is open in other windows');

    // Each space counts its own tabs, and none of a second space's are open elsewhere.
    const { secondSpaceId } = await createSecondSpace(worker);
    await selectSpace(sidebar, 'Second space');
    await expect(sidebar.locator(`.tabs-space-layer[data-space-id="${secondSpaceId}"]`)).toBeVisible();
    await expect(sidebar.locator('.tabs-other-windows')).toHaveCount(0);
    await selectSpace(sidebar, 'Space 1');
    await expect(line).toHaveText('+1 open in other windows');

    // Narrow sidebars keep it at the bottom of the list, down to the narrowest that shows the list.
    for (const width of [300, 180, 150]) {
      await sidebar.setViewportSize({ width, height: 900 });
      await expectAtListBottom(line, lastRow, zone);
      await screenshots(sidebar, `narrow-${width}`);
    }

    // Closing the other window ends the count.
    await closeWindow(worker, otherWindowId);
    await expect(line).toHaveCount(0);
  });
});
