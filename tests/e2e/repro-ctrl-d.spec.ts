import { test } from '@playwright/test';
import { allBookmarks, bookmarkDescendants } from './helpers/chrome';
import { openSidepanel, routeHtml, titledPage, withExtension } from './helpers/extension';


const URL = 'https://star.test/page';

test('repro: Ctrl+D on a page in a space', async () => {
  await withExtension('repro-ctrl-d', async ({ context, worker }) => {
    await routeHtml(context, /https:\/\/star\.test\//, titledPage('Star page'));
    await openSidepanel(context, worker, { width: 900, height: 900 });
    const page = await context.newPage();
    await page.goto(URL);
    await page.waitForTimeout(1500);
    const dump = async (label: string) => {
      const nodes = bookmarkDescendants(await allBookmarks(worker));
      const byId = new Map(nodes.map((node) => [node.id, node]));
      const path = (id?: string): string => {
        const node = id ? byId.get(id) : undefined;
        return node ? `${path(node.parentId)}/${node.title.slice(0, 40)}` : '';
      };
      console.log(label, JSON.stringify(nodes.filter((node) => node.url === URL)
        .map((node) => ({ id: node.id, path: path(node.parentId), title: node.title }))));
    };
    await dump('before');
    await page.bringToFront();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+D' : 'Control+D');
    await page.waitForTimeout(2000);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    await dump('after');
  }, { closeInitialPage: true });
});
