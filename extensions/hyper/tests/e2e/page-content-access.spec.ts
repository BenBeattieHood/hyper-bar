import { expect, test, type Page } from '@playwright/test';
import { openSidepanel, routeHtml, withExtension } from './helpers/extension';
import { permissionRequests, recordPermissionRequests } from './helpers/permissions';

const pageWord = 'zephyrlattice';

async function setPageTextSearch(sidepanel: Page, enabled: boolean) {
  await sidepanel.getByRole('button', { name: 'Open settings' }).click();
  await expect(sidepanel.locator('.settings-layer')).toHaveCSS('transform', 'none');
  const pageText = sidepanel.getByRole('switch', { name: /Include searching within page text/ });
  await pageText.click();
  await expect(pageText).toHaveAttribute('aria-checked', String(enabled));
  await sidepanel.getByRole('button', { name: 'Back' }).click();
}

async function searchFor(sidepanel: Page, query: string) {
  await sidepanel.getByRole('button', { name: 'Search tabs and history' }).click();
  const search = sidepanel.getByRole('combobox', {
    name: 'Search tabs, bookmarks, history, or commands',
  });
  await search.fill(query);
  return sidepanel.getByRole('option', { name: /Reading list article/ });
}

test('page text search finds a tab by its words and turns fully off, with no access prompt', async () => {
  await withExtension('page-content-access', async ({ context, worker }) => {
    await routeHtml(
      context,
      'https://reader.test/**',
      `<!doctype html><title>Reading list article</title><p>A note about ${pageWord}.</p>`,
    );
    const reader = context.pages()[0] ?? await context.newPage();
    await reader.goto('https://reader.test/article');
    await recordPermissionRequests(worker);
    const sidepanel = await openSidepanel(context, worker);

    await setPageTextSearch(sidepanel, true);
    const hit = await searchFor(sidepanel, pageWord);
    await expect(hit).toBeVisible();
    await sidepanel.keyboard.press('Escape');

    await setPageTextSearch(sidepanel, false);
    const staleHit = await searchFor(sidepanel, pageWord);
    await expect(sidepanel.getByRole('option', { name: new RegExp(`Search the web for .${pageWord}.`) }))
      .toBeVisible();
    await expect(staleHit).toHaveCount(0);
    await expect(sidepanel.locator('.countdown-notice [role="status"]')).toHaveCount(0);
    expect(await permissionRequests(worker)).toEqual([]);
  }, { channel: process.env.HYPER_BROWSER_CHANNEL ?? 'chromium' });
});
