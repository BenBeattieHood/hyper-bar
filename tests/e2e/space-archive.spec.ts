import { expect, test, type Locator, type Page, type Worker } from '@playwright/test';
import { allBookmarks } from './helpers/chrome';
import { withHyper } from './helpers/extension';
import { pressAndPull, spaceDotTitles as dotTitles } from './helpers/sidebar';
import { createExtraSpaces, createSecondSpace } from './helpers/spaces';

const withSpaces = (name: string, run: (page: Page, worker: Worker) => Promise<void>) =>
  withHyper(`space-archive-${name}`, async ({ page, worker }) => {
    await expect(page.locator('.space-pagination-dot')).toHaveCount(1);
    await run(page, worker);
  }, { closeInitialPage: true, viewport: { width: 360, height: 760 } });

const visibleTitle = (title: string) => title.replace(/\s+\{.*$/, '');

/** The space folders in bookmark order, by visible title, with whether each is archived. */
async function spaceFolders(worker: Worker): Promise<string[]> {
  const spaces = (await allBookmarks(worker)).find((node) => visibleTitle(node.title) === 'spaces' && node.children);
  return (spaces?.children ?? [])
    .filter((node) => node.children && visibleTitle(node.title) !== 'tabs')
    .map((node) => `${visibleTitle(node.title)}${node.title.includes('"archived":true') ? ' (archived)' : ''}`);
}


const rowTitles = (page: Page) => page.locator('.archived-space-row')
  .evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label')));

const dot = (page: Page, title: string) => page.locator('.space-pagination-dot')
  .filter({ has: page.locator(`.space-pagination-label:text-is("${title}")`) });
const row = (page: Page, title: string) => page.locator(`.archived-space-row[aria-label="${title}"]`);
const archiveButton = (page: Page) => page.locator('.space-archive-button');
const archivePanel = (page: Page) => page.locator('#space-archive-panel');

async function pickUp(page: Page, source: Locator): Promise<void> {
  await pressAndPull(page, source, 3, -12);
  await expect(page.locator('.space-pagination-trash-target')).toBeVisible();
}

async function moveOver(page: Page, target: Locator, xFraction = 0.5): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('Drag fixture was not measurable');
  await page.mouse.move(box.x + box.width * xFraction, box.y + box.height / 2, { steps: 8 });
}

/** A locator's bounds once the pagination has finished resizing for a drag. */
async function settledBounds(locator: Locator) {
  let previous: unknown;
  await expect.poll(async () => {
    const current = JSON.stringify(await locator.boundingBox());
    const settled = current === previous;
    previous = current;
    return settled;
  }, { intervals: [100] }).toBe(true);
  return locator.boundingBox();
}

async function archiveFromMenu(page: Page, title: string): Promise<void> {
  await dot(page, title).click({ button: 'right' });
  await page.getByRole('menu', { name: `Actions for ${title}` }).getByRole('menuitem', { name: 'Archive' }).click();
}

test('the space menu archives a space out of pagination and the archived list brings it back', async () => {
  await withSpaces('menu', async (page, worker) => {
    await createSecondSpace(worker);
    await expect(page.locator('.space-pagination-dot')).toHaveCount(2);
    const [firstTitle] = await dotTitles(page) as [string];
    await expect(archiveButton(page)).toHaveCount(0);

    // Archiving the space the window shows moves the window to its neighbour.
    await expect(dot(page, firstTitle)).toHaveAttribute('aria-current', 'page');
    await archiveFromMenu(page, firstTitle);
    await expect.poll(() => dotTitles(page)).toEqual(['Second space']);
    await expect(dot(page, 'Second space')).toHaveAttribute('aria-current', 'page');
    // An archived space without a chosen place goes last among the archived ones.
    await expect.poll(() => spaceFolders(worker)).toEqual(['Second space', `${firstTitle} (archived)`]);

    // The last shown space offers no Archive.
    await dot(page, 'Second space').click({ button: 'right' });
    const lastMenu = page.getByRole('menu', { name: 'Actions for Second space' });
    await expect(lastMenu).toBeVisible();
    await expect(lastMenu.getByRole('menuitem', { name: 'Archive' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await expect(archiveButton(page)).toBeVisible();
    await archiveButton(page).click();
    await expect(archivePanel(page)).toBeVisible();
    await expect.poll(() => rowTitles(page)).toEqual([firstTitle]);
    // Covered once the reveal has finished.
    await expect(page.locator('.workspace-stack.is-covered')).toHaveCount(1);
    await page.screenshot({ path: 'logs/space-archive-panel.png' });

    // Clicking an archived space does nothing; its menu unarchives it.
    await row(page, firstTitle).click();
    await expect(dot(page, 'Second space')).toHaveAttribute('aria-current', 'page');
    await row(page, firstTitle).click({ button: 'right' });
    const menu = page.getByRole('menu', { name: `Actions for ${firstTitle}` });
    await expect(menu.getByRole('menuitem')).toHaveText(['Unarchive', 'Rename', 'Delete space']);
    await menu.getByRole('menuitem', { name: 'Unarchive' }).click();

    // Unarchived without a place, a space returns at the end of pagination.
    await expect.poll(() => dotTitles(page)).toEqual(['Second space', firstTitle]);
    await expect(archivePanel(page)).toHaveCount(0);
    await expect(archiveButton(page)).toHaveCount(0);
    await expect.poll(() => spaceFolders(worker)).toEqual(['Second space', firstTitle]);
  });
});

test('a squashed pagination hides the archive button along with Add', async () => {
  await withSpaces('squashed', async (page, worker) => {
    await createSecondSpace(worker);
    await createExtraSpaces(worker, 1);
    await expect(page.locator('.space-pagination-dot')).toHaveCount(3);
    const [firstTitle] = await dotTitles(page) as [string];
    await archiveFromMenu(page, firstTitle);
    await expect(page.locator('.space-pagination-dot')).toHaveCount(2);
    await expect(archiveButton(page)).toBeVisible();

    const items = page.locator('.space-pagination-items');
    const addButton = page.locator('.add-space-button');
    await items.evaluate((element) => { element.style.width = '40px'; });
    await expect(items).toHaveClass(/hide-add-space/);
    await expect(addButton).toBeHidden();
    await expect(archiveButton(page)).toBeHidden();
    const dotsWidth = await page.locator('.space-pagination-dots')
      .evaluate((element) => element.getBoundingClientRect().width);
    expect(dotsWidth).toBeGreaterThan(30);

    await items.evaluate((element) => { element.style.removeProperty('width'); });
    await expect(items).not.toHaveClass(/hide-add-space/);
    await expect(addButton).toBeVisible();
    await expect(archiveButton(page)).toBeVisible();
  });
});

test('a space dropped on another dot lands beside its nearer edge', async () => {
  await withSpaces('reorder', async (page, worker) => {
    await createSecondSpace(worker);
    await createExtraSpaces(worker, 2);
    await expect(page.locator('.space-pagination-dot')).toHaveCount(4);
    const [firstTitle] = await dotTitles(page) as [string];

    // Moving right onto the left half of a dot lands before it, so the dots stay put while dragging.
    await pickUp(page, dot(page, firstTitle));
    const overflowBounds = await settledBounds(dot(page, 'Overflow space 1'));
    await moveOver(page, dot(page, 'Overflow space 1'), 0.25);
    await expect(dot(page, 'Overflow space 1')).toHaveClass(/is-insert-before/);
    expect(await dot(page, 'Overflow space 1').boundingBox()).toEqual(overflowBounds);
    await expect(dot(page, 'Overflow space 1')).toHaveCSS('transform', 'none');
    await expect(page.locator('.space-drag-overlay')).toHaveCSS('opacity', '0.4');
    await page.screenshot({ path: 'logs/space-reorder-before.png' });
    await page.mouse.up();
    await expect.poll(() => dotTitles(page))
      .toEqual(['Second space', firstTitle, 'Overflow space 1', 'Overflow space 2']);

    // Moving left onto the right half of a dot lands after it.
    await pickUp(page, dot(page, 'Overflow space 2'));
    await moveOver(page, dot(page, 'Second space'), 0.75);
    await expect(dot(page, 'Second space')).toHaveClass(/is-insert-after/);
    await page.mouse.up();
    await expect.poll(() => dotTitles(page))
      .toEqual(['Second space', 'Overflow space 2', firstTitle, 'Overflow space 1']);
    await expect.poll(() => spaceFolders(worker))
      .toEqual(['Second space', 'Overflow space 2', firstTitle, 'Overflow space 1']);

    // A keyboard step right moves a space past its neighbour.
    await dot(page, 'Second space').focus();
    await page.keyboard.press('Space');
    await expect(page.locator('.space-pagination-trash-target')).toBeVisible();
    await settledBounds(dot(page, 'Overflow space 2'));
    await page.keyboard.press('ArrowRight');
    await expect(dot(page, 'Overflow space 2')).toHaveClass(/is-insert-after/);
    await page.keyboard.press('Space');
    await expect.poll(() => dotTitles(page))
      .toEqual(['Overflow space 2', 'Second space', firstTitle, 'Overflow space 1']);
  });
});

test('spaces drag into the archive, to a chosen place in it, and back out to pagination', async () => {
  await withSpaces('drag', async (page, worker) => {
    await createSecondSpace(worker);
    await createExtraSpaces(worker, 2);
    await expect(page.locator('.space-pagination-dot')).toHaveCount(4);
    const [firstTitle] = await dotTitles(page) as [string];

    // The Archive button appears for any space drag, and a drop on it archives the space.
    await pickUp(page, dot(page, 'Overflow space 1'));
    await expect(archiveButton(page)).toBeVisible();
    await moveOver(page, archiveButton(page));
    await expect(archiveButton(page)).toHaveClass(/is-over/);
    await page.mouse.up();
    await expect.poll(() => dotTitles(page)).toEqual([firstTitle, 'Second space', 'Overflow space 2']);
    await expect(archivePanel(page)).toHaveCount(0);

    // Holding a drag on the button opens the list to drop the space at a row.
    await pickUp(page, dot(page, 'Overflow space 2'));
    await moveOver(page, archiveButton(page));
    await expect(archivePanel(page)).toBeVisible({ timeout: 2_000 });
    await moveOver(page, row(page, 'Overflow space 1'));
    await expect(row(page, 'Overflow space 1')).toHaveClass(/is-insert-before/);
    await page.screenshot({ path: 'logs/space-archive-drop-row.png' });
    await page.mouse.up();
    await expect.poll(() => rowTitles(page)).toEqual(['Overflow space 2', 'Overflow space 1']);
    await expect.poll(() => dotTitles(page)).toEqual([firstTitle, 'Second space']);

    // An archived row dropped on the left half of a dot unarchives the space before it.
    await pickUp(page, row(page, 'Overflow space 1'));
    await moveOver(page, dot(page, firstTitle), 0.25);
    await expect(dot(page, firstTitle)).toHaveClass(/is-insert-before/);
    await page.screenshot({ path: 'logs/space-archive-unarchive.png' });
    await page.mouse.up();
    await expect.poll(() => dotTitles(page)).toEqual(['Overflow space 1', firstTitle, 'Second space']);
    await expect.poll(() => rowTitles(page)).toEqual(['Overflow space 2']);
    await expect.poll(() => spaceFolders(worker)).toEqual([
      'Overflow space 1',
      firstTitle,
      'Second space',
      'Overflow space 2 (archived)',
    ]);
  });
});
