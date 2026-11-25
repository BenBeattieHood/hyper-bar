import { expect, test, type Locator } from '@playwright/test';
import { callChrome } from './helpers/chrome';
import { routeHtml, sidepanelUrl, withExtension } from './helpers/extension';
import { createMotionFixture, settleMotionFixture } from './helpers/motion';
import { spaceDot, spaceDotById } from './helpers/sidebar';
import { createExtraSpaces, waitForTabSpaceGroup } from './helpers/spaces';
import { browserTab } from './helpers/tabs';

const cssValue = (locator: Locator, property: string) =>
  locator.evaluate((element, property) => getComputedStyle(element).getPropertyValue(property).trim(), property);

test('a space wears its tab group colour, and a space with no group wears the muted icon colour', async () => {
  await withExtension('space-colours', async ({ context, worker }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 900, height: 900 });
    await routeHtml(context, 'https://motion.test/**', '<!doctype html><title>Space colour fixture</title>');
    const fixture = await createMotionFixture(worker);
    await settleMotionFixture(worker, fixture);
    await createExtraSpaces(worker, 1);
    await page.goto(sidepanelUrl(worker));
    await waitForTabSpaceGroup(worker, fixture.firstTabId, fixture.firstSpaceId);

    const root = page.locator(':root');
    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await cssValue(root, '--tab-group-red')).toBe('#cf87da');
    expect(await cssValue(root, '--tab-group-green')).toBe('#4a89ba');
    await page.emulateMedia({ colorScheme: 'light' });
    expect(await cssValue(root, '--tab-group-red')).toBe('#c239b3');
    expect(await cssValue(root, '--tab-group-green')).toBe('#004e8c');

    const { groupId } = await browserTab(worker, fixture.firstTabId);
    const group = await callChrome<{ color: string }>(worker, 'tabGroups.get', groupId);
    const firstDot = spaceDotById(page, fixture.firstSpaceId);
    await expect(firstDot).toHaveAttribute('data-group-colour', group.color);

    const recolour = group.color === 'purple' ? 'cyan' : 'purple';
    await callChrome(worker, 'tabGroups.update', groupId, { color: recolour });
    await expect(firstDot).toHaveAttribute('data-group-colour', recolour);
    expect(await cssValue(firstDot, '--space-dot-colour')).toBe(await cssValue(firstDot, `--tab-group-${recolour}`));

    const ungroupedDot = spaceDot(page, 'Overflow space 1');
    await expect(ungroupedDot).toBeVisible();
    await expect(ungroupedDot).not.toHaveAttribute('data-group-colour');
    expect(await cssValue(ungroupedDot, '--space-dot-colour')).toBe(await cssValue(ungroupedDot, '--muted'));

    const spaceTitles = await callChrome<Array<{ title: string }>>(worker, 'bookmarks.get', [
      fixture.firstSpaceId,
      fixture.secondSpaceId,
    ]);
    for (const { title } of spaceTitles) expect(title).not.toContain('colour');
  }, { closeInitialPage: true });
});
