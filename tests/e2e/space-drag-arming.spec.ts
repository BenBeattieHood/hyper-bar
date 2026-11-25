import { expect, test, type Locator, type Page, type Worker } from '@playwright/test';
import { saveHyperPreference } from './fixtures/preferences';
import { bookmarkParentId, callChrome } from './helpers/chrome';
import { routePathTitles, sidepanelUrl, withExtension } from './helpers/extension';
import type { ExtensionGlobal } from './helpers/extensionGlobal';
import { spaceDotById } from './helpers/sidebar';

const PAGE = (name: string) => `https://space-arming.test/${name}`;

interface Fixture {
  globalReadingId: string;
  homeBookmarkId: string;
  homeSpaceId: string;
  workRootId: string;
  workSpaceId: string;
}

interface FixtureNode {
  children?: FixtureNode[];
  id: string;
  title: string;
  url?: string;
}

/**
 * Two spaces with their own bookmarks, and one global bookmark. Hyper builds
 * its folders as it starts, so the fixture waits for them and builds on them
 * rather than racing it to a second, competing structure.
 */
async function createFixture(worker: Worker): Promise<Fixture> {
  const spaceRoot = (space: FixtureNode) => space.children?.find((child) =>
    !child.url && child.title.startsWith('bookmarks {') && child.title.includes('spaceBookmarks'));
  const repairedTree = async () => {
    const [root] = await callChrome<FixtureNode[]>(worker, 'bookmarks.getTree');
    const hyper = root?.children?.[0]?.children?.find((node) => !node.url && node.title.startsWith('hyper'));
    const folder = (title: string) => hyper?.children?.find((node) =>
      !node.url && (node.title === title || node.title.startsWith(`${title} {`)));
    const firstSpace = folder('spaces')?.children?.find((node) => !node.url);
    const homeRoot = firstSpace && spaceRoot(firstSpace);
    const global = folder('bookmarks');
    const spaces = folder('spaces');
    return firstSpace && homeRoot && global && spaces
      ? { firstSpace, global, homeRoot, spaces }
      : undefined;
  };
  let repaired: Awaited<ReturnType<typeof repairedTree>>;
  await expect.poll(async () => {
    repaired = await repairedTree();
    return repaired !== undefined;
  }, { message: 'Hyper never built its bookmark structure.' }).toBe(true);
  const { firstSpace, global, homeRoot, spaces } = repaired!;
  return worker.evaluate(async ({ globalId, homeId, homeRootId, homeUrl, readingUrl, spacesId, workUrl }) => {
    const { bookmarks } = (globalThis as unknown as ExtensionGlobal).chrome;
    await bookmarks.update(homeId, { title: 'Home' });
    const reading = await bookmarks.create({ parentId: globalId, title: 'Reading', url: readingUrl });
    const work = await bookmarks.create({ parentId: spacesId, title: 'Work' });
    const workRoot = await bookmarks.create({
      parentId: work.id,
      title: `bookmarks ${JSON.stringify({ hyper: { spaceBookmarks: true, spaceId: work.id } })}`,
    });
    const homeBookmark = await bookmarks.create({ parentId: homeRootId, title: 'Home page', url: homeUrl });
    await bookmarks.create({ parentId: workRoot.id, title: 'Work page', url: workUrl });
    return {
      globalReadingId: reading.id,
      homeBookmarkId: homeBookmark.id,
      homeSpaceId: homeId,
      workRootId: workRoot.id,
      workSpaceId: work.id,
    };
  }, {
    globalId: global.id,
    homeId: firstSpace.id,
    homeRootId: homeRoot.id,
    homeUrl: PAGE('home-bookmark'),
    readingUrl: PAGE('reading'),
    spacesId: spaces.id,
    workUrl: PAGE('work-bookmark'),
  });
}

async function withSidebar(run: (page: Page, worker: Worker, fixture: Fixture) => Promise<void>) {
  await withExtension('space-drag-arming', async ({ context, worker }) => {
    await routePathTitles(context, 'https://space-arming.test/**');
    const fixture = await createFixture(worker);
    await saveHyperPreference(worker, 'combineTabsAndBookmarks', false);
    const tab = await context.newPage();
    await tab.goto(PAGE('one'));
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(sidepanelUrl(worker));
    await expect(spaceDotById(page, fixture.homeSpaceId)).toHaveAttribute('aria-current', 'page');
    await run(page, worker, fixture);
  });
}

async function centre(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Drag fixture was not measurable');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function pickUp(page: Page, source: Locator): Promise<void> {
  const { x, y } = await centre(source);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 12, { steps: 3 });
  await expect(page.locator('.space-pagination-trash-target')).toBeVisible();
}

function fillAnimation(locator: Locator, pseudo?: string) {
  return locator.evaluate((element, pseudoElement) => {
    const style = getComputedStyle(element, pseudoElement);
    return {
      name: style.animationName,
      duration: style.animationDuration,
      timing: style.animationTimingFunction,
      fill: style.animationFillMode,
      background: style.backgroundImage,
      inset: [style.top, style.right, style.bottom, style.left].map((side) => side === '0px'),
    };
  }, pseudo ?? null);
}

async function moveOver(page: Page, target: Locator): Promise<void> {
  const { x, y } = await centre(target);
  await page.mouse.move(x, y, { steps: 8 });
}

/** Picks up the tab on `PAGE('one')` and holds it over Work, which starts arming. */
async function holdTabOverWork(page: Page, fixture: Fixture): Promise<{ tabRow: Locator; work: Locator }> {
  const tabRow = page.locator(`.tab-row:has(.tab-main[data-url="${PAGE('one')}"])`);
  // The tab is briefly shown twice while the sidebar links it to its bookmark.
  await expect(tabRow).toHaveCount(1);
  await pickUp(page, tabRow);
  const work = spaceDotById(page, fixture.workSpaceId);
  await moveOver(page, work);
  await expect(work.locator('.space-pagination-drag-arming')).toHaveCount(1);
  return { tabRow, work };
}

/** From the Bookmarks view, picks up Home's bookmark and holds it over the Tabs view tab. */
async function holdBookmarkOverTabsView(page: Page, fixture: Fixture): Promise<Locator> {
  await page.locator('#workspace-tab-bookmarks').click();
  const bookmark = page.locator(`[data-bookmark-node-id="${fixture.homeBookmarkId}"] .tree-item-main`);
  await pickUp(page, bookmark);
  const tabsViewTab = page.locator('#workspace-tab-tabs');
  await moveOver(page, tabsViewTab);
  return tabsViewTab;
}

test('a tab held over another space opens that space to its tabs, ready for the drop', async () => {
  await withSidebar(async (page, _worker, fixture) => {
    const { tabRow, work } = await holdTabOverWork(page, fixture);
    await expect(work).toHaveAttribute('aria-current', 'page');
    await expect(work.locator('.space-pagination-drag-arming')).toHaveCount(0);
    await expect(page.locator('#workspace-tab-tabs')).toHaveAttribute('aria-selected', 'true');

    // The tab still belongs to Home, and lands in Work's list where it drops.
    const tabsPanel = page.locator('#workspace-panel-tabs');
    await expect(tabsPanel.locator(tabRow)).toHaveCount(0);
    await moveOver(page, tabsPanel.locator('.tabs-drop-zone'));
    await page.mouse.up();
    await expect(work).toHaveAttribute('aria-current', 'page');
    await expect(tabsPanel.locator(tabRow)).toHaveCount(1);
  });
});

test('a space bookmark held over another space opens that space to its bookmarks, even from the Tabs view', async () => {
  await withSidebar(async (page, worker, fixture) => {
    // A drag held over the Tabs view tab switches to tabs first.
    const tabsViewTab = await holdBookmarkOverTabsView(page, fixture);
    await expect(tabsViewTab).toHaveClass(/is-drag-arming/);
    const viewTabFill = await fillAnimation(tabsViewTab, '::after');
    await expect(tabsViewTab).toHaveAttribute('aria-selected', 'true');

    const work = spaceDotById(page, fixture.workSpaceId);
    await moveOver(page, work);
    const spaceFill = work.locator('.space-pagination-drag-arming');
    await expect(spaceFill).toHaveCount(1);
    // The space plays the very fill the view tabs play.
    expect(await fillAnimation(spaceFill)).toEqual(viewTabFill);
    expect(viewTabFill).toMatchObject({ name: 'workspace-drag-glimmer', duration: '0.5s' });
    await expect(work).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#workspace-tab-bookmarks')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Work page')).toBeVisible();

    await moveOver(page, page.getByText('Work page'));
    // Released once the list shows where it lands, as a person would; the space's list is still rendering.
    await expect(page.locator('.tree-drop-placeholder')).toBeVisible();
    await page.mouse.up();
    await expect.poll(() => bookmarkParentId(worker, fixture.homeBookmarkId)).toBe(fixture.workRootId);
  });
});

test('a global bookmark held over a space closes global bookmarks and opens that space to its bookmarks', async () => {
  await withSidebar(async (page, _worker, fixture) => {
    await page.getByRole('button', { name: 'Global bookmarks' }).click();
    const panel = page.locator('#global-bookmarks-panel');
    const reading = panel.locator(`[data-bookmark-node-id="${fixture.globalReadingId}"] .tree-item-main`);
    // The panel expands from the button; the space beneath goes once it is covered.
    await expect(page.locator('.space-panel:not(.global-bookmarks-panel)')).toHaveCount(0);
    await pickUp(page, reading);
    const work = spaceDotById(page, fixture.workSpaceId);
    await moveOver(page, work);
    await expect(work).toHaveAttribute('aria-current', 'page');
    await expect(panel).toHaveCount(0);
    await expect(page.locator('#workspace-tab-bookmarks')).toHaveAttribute('aria-selected', 'true');

    // Escape cancels the drag and returns to where it began.
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(spaceDotById(page, fixture.homeSpaceId)).toHaveAttribute('aria-current', 'page');
    await expect(panel).toBeVisible();
    await expect(panel.locator(`[data-bookmark-node-id="${fixture.globalReadingId}"]`)).toBeVisible();
  });
});

test('a drag dropped where nothing lands returns to the space and view it began in', async () => {
  await withSidebar(async (page, worker, fixture) => {
    const tabsViewTab = await holdBookmarkOverTabsView(page, fixture);
    await expect(tabsViewTab).toHaveAttribute('aria-selected', 'true');
    const work = spaceDotById(page, fixture.workSpaceId);
    await moveOver(page, work);
    await expect(work).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText('Work page')).toBeVisible();

    await moveOver(page, page.locator('.settings-button'));
    await page.mouse.up();
    await expect(spaceDotById(page, fixture.homeSpaceId)).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#workspace-tab-bookmarks')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(`[data-bookmark-node-id="${fixture.homeBookmarkId}"]`)).toBeVisible();
    expect(await bookmarkParentId(worker, fixture.homeBookmarkId)).not.toBe(fixture.workRootId);
  });
});

test('a drag that passes over a space without holding there leaves the active space alone', async () => {
  await withSidebar(async (page, _worker, fixture) => {
    const { tabRow, work } = await holdTabOverWork(page, fixture);
    await moveOver(page, tabRow);
    await expect(work.locator('.space-pagination-drag-arming')).toHaveCount(0);
    await page.waitForTimeout(700);
    await expect(spaceDotById(page, fixture.homeSpaceId)).toHaveAttribute('aria-current', 'page');
    await page.keyboard.press('Escape');
    await page.mouse.up();
  });
});
