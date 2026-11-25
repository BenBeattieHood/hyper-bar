import { expect, test } from '@playwright/test';
import { seedHyperSpace } from './helpers/chrome';
import { openSidepanel, routeHtml, withExtension } from './helpers/extension';

const PAGE_URL = 'https://duplicate-bookmark.test/page';

test('selects the clicked bookmark when duplicate URLs exist', async () => {
  await withExtension('duplicate-bookmark', async ({ context, worker }) => {
    await routeHtml(context, 'https://duplicate-bookmark.test/**', '<!doctype html><title>Duplicate bookmark page</title>');
    const fixture = await seedHyperSpace<'first' | 'second'>(worker, {
      bookmarks: [
        { key: 'first', title: 'First copy', url: PAGE_URL },
        { key: 'second', title: 'Second copy', url: PAGE_URL },
      ],
    });
    const sidepanelPage = await openSidepanel(context, worker, { width: 900, height: 900 });

    const firstRow = sidepanelPage.locator(`[data-bookmark-node-id="${fixture.first}"]`);
    const secondRow = sidepanelPage.locator(`[data-bookmark-node-id="${fixture.second}"]`);
    await expect(firstRow).toBeVisible();
    await expect(secondRow).toBeVisible();

    await secondRow.locator('.tree-item-main').click();

    await expect(secondRow.locator('.tree-item-main')).toHaveAttribute('aria-selected', 'true');
    await expect(firstRow.locator('.tree-item-main')).toHaveAttribute('aria-selected', 'false');
    await expect(sidepanelPage.locator('.tree-item-main[aria-selected="true"]')).toHaveCount(1);
  });
});
