import { expect, test } from '@playwright/test';
import { callChrome, seedHyperSpace } from './helpers/chrome';
import { openSidepanel, routeHtml, withExtension } from './helpers/extension';
import { createTab } from './helpers/tabs';

test('finds GitHub pages from every source with a partial URL query', async () => {
  await withExtension('partial-search', async ({ context, worker }) => {
    await routeHtml(context, 'https://github-*.test/**', '<!doctype html><title>GitHub tab</title>');
    await seedHyperSpace(worker, {
      favourites: [{ title: 'GitHub favourite', url: 'https://github-favourite.test/project' }],
      space: 'Current space',
      bookmarks: [{ title: 'GitHub bookmark', url: 'https://github-bookmark.test/project' }],
    });
    await callChrome(worker, 'history.addUrl', { url: 'https://github-history.test/project' });
    await createTab(worker, 'https://github-tab.test/project', { active: false });

    const sidepanel = await openSidepanel(context, worker);
    await sidepanel.getByRole('button', { name: 'Search tabs and history' }).click();
    const search = sidepanel.getByRole('combobox', {
      name: 'Search tabs, bookmarks, history, or commands',
    });
    await search.fill('gith');

    await expect(sidepanel.getByRole('option', { name: /GitHub favourite/i })).toBeVisible();
    await expect(sidepanel.getByRole('option', { name: /GitHub bookmark/i })).toBeVisible();
    await expect(sidepanel.getByRole('option', { name: /github-tab\.test/i })).toBeVisible();
    await expect(sidepanel.getByRole('option', { name: /github-history\.test/i })).toBeVisible();
  }, { channel: process.env.HYPER_BROWSER_CHANNEL ?? 'chromium' });
});
