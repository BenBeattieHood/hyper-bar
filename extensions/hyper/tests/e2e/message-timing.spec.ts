import { expect, test } from '@playwright/test';
import { readHyperPreferences } from './fixtures/preferences';
import { routePathTitles, withHyper } from './helpers/extension';
import { backedTabOrder, dragTabRowBefore } from './helpers/sidebar';
import { createTab } from './helpers/tabs';

test('the message timing slider marks each second, saves on the root folder and sets how long messages stay', async () => {
  await withHyper('message-timing', async ({ context, page, worker }) => {
    await routePathTitles(context, /^https:\/\/timing\.test\//, 'Page ');
    await page.setViewportSize({ width: 720, height: 900 });
    await expect(page.locator('.space-pagination-dot')).toHaveCount(1);

    await page.getByRole('button', { name: 'Open settings' }).click();
    const slider = page.getByRole('slider', { name: 'Message timing' });
    const value = page.locator('.settings-slider-value');
    const dots = page.locator('.settings-slider-dot');
    const filledDots = page.locator('.settings-slider-fill .settings-slider-dot');
    await expect(slider).toHaveValue('7');
    await expect(slider).toHaveAttribute('aria-valuetext', '7 seconds');
    await expect(value).toHaveText('7s');
    await expect(page.locator('.settings-slider-scale')).toHaveText('FastRelaxed');
    await expect(dots).toHaveCount(13);
    await expect(filledDots).toHaveCount(4);

    // Dots shrink to stay apart on a narrow sidebar, and merge into the bar once they cannot.
    for (const [width, dotWidth] of [[244, '6px'], [200, '4px'], [720, '8px']] as const) {
      await page.setViewportSize({ width, height: 900 });
      await expect(dots.first()).toHaveCSS('width', dotWidth);
    }

    // Each dot sits where the thumb stops, so a click just either side of the midpoint between two dots picks the nearer.
    await expect(page.locator('.settings-layer')).toHaveCSS('transform', 'none');
    const bounds = await slider.boundingBox();
    if (!bounds) throw new Error('The slider was not measurable');
    const y = bounds.y + bounds.height / 2;
    const dotCentre = async (seconds: number) => {
      const dot = await dots.nth(seconds - 3).boundingBox();
      if (!dot) throw new Error(`The ${seconds}s dot was not measurable`);
      return dot.x + dot.width / 2;
    };
    const midpoint = (await dotCentre(13) + await dotCentre(14)) / 2;
    await page.mouse.click(midpoint - 2, y);
    await expect(slider).toHaveValue('13');
    await page.mouse.click(midpoint + 2, y);
    await expect(slider).toHaveValue('14');
    await expect(filledDots).toHaveCount(11);
    await expect.poll(async () => (await readHyperPreferences(worker)).timedMessageSeconds).toBe(14);

    await slider.focus();
    await page.keyboard.press('End');
    await expect(value).toHaveText('15s');
    await expect(filledDots).toHaveCount(12);
    await expect.poll(async () => (await readHyperPreferences(worker)).timedMessageSeconds).toBe(15);

    // Dragging past the fast end shows each value at once and saves once the drag ends.
    await page.mouse.move(bounds.x + bounds.width - 4, y);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2, y, { steps: 6 });
    await expect(value).not.toHaveText('15s');
    expect((await readHyperPreferences(worker)).timedMessageSeconds).toBe(15);
    await page.mouse.move(bounds.x - 40, y, { steps: 6 });
    await page.mouse.up();
    await expect(value).toHaveText('3s');
    await expect(filledDots).toHaveCount(0);
    await expect.poll(async () => (await readHyperPreferences(worker)).timedMessageSeconds).toBe(3);
    await page.getByRole('button', { name: 'Back' }).click();

    const tabs: number[] = [];
    for (const path of ['a', 'b']) tabs.push(await createTab(worker, `https://timing.test/${path}`, { active: false }));
    const [first, second] = tabs as [number, number];
    await expect.poll(() => backedTabOrder(page, tabs)).toEqual([first, second]);
    await dragTabRowBefore(page, second, first);

    const notice = page.locator('.topbar .countdown-notice');
    await expect(notice.getByRole('status')).toHaveText('Moved tab');
    await expect(notice.locator('.countdown-button'))
      .toHaveCSS('--countdown-duration', '3000ms');
    await expect(notice).toHaveCount(0, { timeout: 4_500 });
  }, { closeInitialPage: true });
});

test('a middle click closes a timed message without pressing its button', async () => {
  await withHyper('message-middle-click', async ({ context, page, worker }) => {
    await routePathTitles(context, /^https:\/\/timing\.test\//, 'Page ');
    await page.setViewportSize({ width: 720, height: 900 });
    const tabs: number[] = [];
    for (const path of ['a', 'b']) tabs.push(await createTab(worker, `https://timing.test/${path}`, { active: false }));
    const [first, second] = tabs as [number, number];
    await expect.poll(() => backedTabOrder(page, tabs)).toEqual([first, second]);
    await dragTabRowBefore(page, second, first);

    const notice = page.locator('.topbar .countdown-notice');
    await expect(notice.getByRole('status')).toHaveText('Moved tab');
    // It slides down into place as it shows.
    await expect(notice).toHaveCSS('opacity', '1');
    await expect(notice).toHaveCSS('transform', 'none');

    await notice.getByRole('status').click({ button: 'middle' });
    await expect(notice).toHaveCount(0);
    await expect(page.locator('.topbar-space-title')).toBeVisible();
    await page.waitForTimeout(300);
    expect(await backedTabOrder(page, tabs)).toEqual([second, first]);
  }, { closeInitialPage: true });
});
