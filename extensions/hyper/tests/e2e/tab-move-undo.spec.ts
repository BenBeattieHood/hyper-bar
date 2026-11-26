import { expect, test } from '@playwright/test';
import { routePathTitles, withHyper } from './helpers/extension';
import { answerNotice, backedTabOrder, dragTabRowBefore, renderedTabOrder } from './helpers/sidebar';
import { createTab, nativeTabOrder } from './helpers/tabs';

test('a tab moved in the list offers undo, which puts it back in the list and the tab strip', async () => {
  await withHyper('tab-move-undo', async ({ context, page, worker }) => {
    await routePathTitles(context, /^https:\/\/undo\.test\//, 'Page ');
    await page.setViewportSize({ width: 720, height: 900 });
    await expect(page.locator('.space-pagination-dot')).toHaveCount(1);
    const tabs: number[] = [];
    for (const path of ['a', 'b', 'c']) tabs.push(await createTab(worker, `https://undo.test/${path}`, { active: false }));
    const [first, second, third] = tabs as [number, number, number];
    await expect.poll(() => backedTabOrder(page, tabs)).toEqual([first, second, third]);
    await expect.poll(() => nativeTabOrder(worker, tabs)).toEqual([first, second, third]);

    await dragTabRowBefore(page, third, first);

    await expect.poll(() => renderedTabOrder(page, tabs)).toEqual([third, first, second]);
    await answerNotice(page, 'Moved tab', 'Undo', 'lucide-undo-2');

    await expect.poll(() => renderedTabOrder(page, tabs)).toEqual([first, second, third]);
    await expect.poll(() => nativeTabOrder(worker, tabs)).toEqual([first, second, third]);
  }, { closeInitialPage: true });
});
