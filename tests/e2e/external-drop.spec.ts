import { expect, test, type Locator, type Page, type Worker } from '@playwright/test';
import { bookmarkChildren, seedHyperSpace } from './helpers/chrome';
import { openSidepanel, routePathTitles, withExtension } from './helpers/extension';
import { openTabUrls } from './helpers/tabs';

const PAGE = (name: string) => `https://external.test/${name}`;

interface Fixture {
  existingId: string;
  favouritesId: string;
  spaceBookmarksId: string;
}

// A space with one bookmark, and an empty favourites bar.
async function createFixture(worker: Worker): Promise<Fixture> {
  const ids = await seedHyperSpace<'existing'>(worker, {
    globalBookmarks: [],
    bookmarks: [{ key: 'existing', title: 'Existing', url: PAGE('existing') }],
  });
  return { existingId: ids.existing, favouritesId: ids.favourites, spaceBookmarksId: ids.spaceBookmarks };
}

const children = async (worker: Worker, parentId: string) =>
  (await bookmarkChildren(worker, parentId)).map(({ title, url }) => ({ title: title.replace(/ \{.*\}$/, ''), url }));

async function withSidebar(run: (page: Page, worker: Worker, fixture: Fixture) => Promise<void>) {
  await withExtension('external-drop', async ({ context, worker }) => {
    await routePathTitles(context, 'https://external.test/**');
    const fixture = await createFixture(worker);
    const page = await openSidepanel(context, worker, { width: 360, height: 820 });
    await expect(page.locator('.favourites-grid > .favourite-slot')).toHaveCount(8);
    await run(page, worker, fixture);
  });
}

interface Dragged {
  files?: Array<{ body: string; name: string; type?: string }>;
  strings?: Record<string, string>;
}

/**
 * Plays the browser's part in a drag from outside Hyper: it enters the sidebar
 * at its top, moves over the target, and is held there, before `drop` lets go.
 * The page holds one DataTransfer for the drag, as the browser would.
 */
async function dragIn(page: Page, target: Locator, dragged: Dragged, { yFraction = 0.5 } = {}) {
  await page.evaluate((data) => {
    const transfer = new DataTransfer();
    for (const [type, value] of Object.entries(data.strings ?? {})) transfer.setData(type, value);
    for (const file of data.files ?? []) transfer.items.add(new File([file.body], file.name, { type: file.type ?? '' }));
    (globalThis as unknown as { externalTransfer: DataTransfer }).externalTransfer = transfer;
  }, dragged);
  await dispatch(page, 'dragenter', { x: 180, y: 4 });
  const box = await target.boundingBox();
  if (!box) throw new Error('The drop target had no geometry');
  const point = { x: box.x + box.width / 2, y: box.y + box.height * yFraction };
  for (const step of [0.5, 1]) {
    await dispatch(page, 'dragover', { x: 180 + (point.x - 180) * step, y: 4 + (point.y - 4) * step });
  }
  await dispatch(page, 'dragover', point);
  return point;
}

async function dispatch(page: Page, type: 'dragenter' | 'dragleave' | 'dragover' | 'drop', point: { x: number; y: number }) {
  await page.evaluate(({ eventType, x, y }) => {
    const transfer = (globalThis as unknown as { externalTransfer: DataTransfer }).externalTransfer;
    const target = document.elementFromPoint(x, y) ?? document.body;
    target.dispatchEvent(new DragEvent(eventType, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      dataTransfer: transfer,
      relatedTarget: eventType === 'dragleave' ? null : target,
    }));
  }, { eventType: type, x: point.x, y: point.y });
  // Lets dnd-kit measure and React paint between the browser's events.
  await page.waitForTimeout(60);
}

async function dropOn(page: Page, target: Locator, dragged: Dragged, options?: { yFraction?: number }) {
  const point = await dragIn(page, target, dragged, options);
  await dispatch(page, 'drop', point);
}

const notice = (page: Page) => page.locator('.topbar .countdown-notice [role="status"]');

test('a link dragged from a page onto a bookmark lands after it, titled as the page linked it', async () => {
  await withSidebar(async (page, worker, fixture) => {
    const existing = page.locator(`[data-bookmark-node-id="${fixture.existingId}"]`);
    await expect(existing).toBeVisible();

    await dragIn(page, existing, {
      strings: {
        'text/html': `<a href="${PAGE('article')}">A good &amp; long read</a>`,
        'text/plain': PAGE('article'),
        'text/uri-list': PAGE('article'),
      },
    }, { yFraction: 0.85 });
    const overlay = page.locator('.drag-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('.drag-add-badge')).toBeVisible();
    await expect(page.locator('.tree-drop-placeholder.is-after:not(.is-invalid)')).toBeVisible();
    await dispatch(page, 'drop', await existing.boundingBox().then((box) => ({
      x: box!.x + box!.width / 2,
      y: box!.y + box!.height * 0.85,
    })));

    await expect.poll(() => children(worker, fixture.spaceBookmarksId)).toEqual([
      { title: 'Existing', url: PAGE('existing') },
      { title: 'A good & long read', url: PAGE('article') },
    ]);
    await expect(overlay).toHaveCount(0);
  });
});

test('links dropped below the bookmarks go last, and ones already there are not added twice', async () => {
  await withSidebar(async (page, worker, fixture) => {
    await dropOn(page, page.locator('.tree-drop-zone .tree-root-drop-target').first(), {
      strings: { 'text/uri-list': `${PAGE('one')}\r\n${PAGE('existing')}\r\n${PAGE('two')}` },
    });
    await expect.poll(async () => (await children(worker, fixture.spaceBookmarksId)).map((child) => child.url))
      .toEqual([PAGE('existing'), PAGE('one'), PAGE('two')]);
  });
});

test('a shortcut file dropped on the tabs opens its page, and a file that cannot be linked is named', async () => {
  await withSidebar(async (page, worker) => {
    await dropOn(page, page.locator('.tabs-drop-zone'), {
      files: [
        { body: `[InternetShortcut]\r\nURL=${PAGE('shortcut')}\r\n`, name: 'Shortcut.url' },
        { body: '%PDF-1.4', name: 'report.pdf', type: 'application/pdf' },
      ],
    }, { yFraction: 0.9 });
    await expect.poll(() => openTabUrls(worker)).toContain(PAGE('shortcut'));
    // The new tab is briefly shown twice while the sidebar links it to its row.
    await expect(page.locator(`.tab-row .tab-main[data-url="${PAGE('shortcut')}"]`)).toHaveCount(1);
    await expect(notice(page)).toContainText('“report.pdf” is a file');
  });
});

test('a link dropped on a favourite slot is pinned there', async () => {
  await withSidebar(async (page, worker, fixture) => {
    await dropOn(page, page.locator('.favourites-grid > .favourite-slot').nth(2), {
      strings: { 'text/x-moz-url': `${PAGE('pinned')}\nPinned page`, 'text/uri-list': PAGE('pinned') },
    });
    await expect.poll(() => children(worker, fixture.favouritesId)).toEqual([{ title: 'Pinned page', url: PAGE('pinned') }]);
    await expect(page.locator('.favourites-grid > .favourite-slot').nth(2).locator('.favourite-tile.is-pinned'))
      .toHaveAttribute('data-url', PAGE('pinned'));
  });
});

test('a file with no link, or a drag that leaves, adds nothing', async () => {
  await withSidebar(async (page, worker, fixture) => {
    const zone = page.locator('.tree-drop-zone .tree-root-drop-target').first();
    await dropOn(page, zone, { files: [{ body: 'jpeg', name: 'photo.jpg', type: 'image/jpeg' }] });
    await expect(notice(page)).toContainText('“photo.jpg” is a file');

    await dragIn(page, zone, { strings: { 'text/uri-list': PAGE('left') } });
    await expect(page.locator('.drag-overlay')).toBeVisible();
    await dispatch(page, 'dragleave', { x: 180, y: 4 });
    await expect(page.locator('.drag-overlay')).toHaveCount(0);
    expect((await children(worker, fixture.spaceBookmarksId)).map((child) => child.url)).toEqual([PAGE('existing')]);
  });
});
