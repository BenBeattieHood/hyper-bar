import { expect, test, type Page, type Worker } from '@playwright/test';
import { bookmarkChildren, seedHyperSpace } from './helpers/chrome';
import { openSidepanel, withExtension } from './helpers/extension';
import { pressAndPull } from './helpers/sidebar';

interface Fixture {
  alphaId: string;
  betaId: string;
  folderId: string;
  gammaId: string;
}

// The space's bookmarks: Alpha, Beta, Gamma, Folder/ (empty)
async function createFixture(worker: Worker): Promise<Fixture> {
  const ids = await seedHyperSpace<'Alpha' | 'Beta' | 'Folder' | 'Gamma'>(worker, {
    bookmarks: [
      ...(['Alpha', 'Beta', 'Gamma'] as const).map((title) => ({
        key: title,
        title,
        url: `https://multi-drag.test/${title.toLowerCase()}`,
      })),
      { key: 'Folder', title: 'Folder' },
    ],
  });
  return { alphaId: ids.Alpha, betaId: ids.Beta, folderId: ids.Folder, gammaId: ids.Gamma };
}

const row = (page: Page, nodeId: string) =>
  page.locator(`[data-bookmark-node-id="${nodeId}"] .tree-item-main`).first();
const listItem = (page: Page, nodeId: string) =>
  page.locator(`[data-bookmark-node-id="${nodeId}"]`).first().locator('xpath=ancestor::li[1]');

interface HeightSample {
  at: number;
  height: number;
}

/** Records a row's list item height every frame for a while, starting now. */
const sampleHeights = (page: Page, nodeId: string, duration: number) => page.evaluate(
  ({ id, ms }) => {
    const samples: HeightSample[] = [];
    (window as unknown as { heightSamples: HeightSample[] }).heightSamples = samples;
    const started = performance.now();
    const sample = () => {
      const item = document.querySelector(`[data-bookmark-node-id="${id}"]`)?.closest('li');
      samples.push({ at: performance.now(), height: item ? item.getBoundingClientRect().height : 0 });
      if (performance.now() - started < ms) requestAnimationFrame(sample);
    };
    sample();
  },
  { id: nodeId, ms: duration },
);
const heightSamples = (page: Page) =>
  page.evaluate(() => (window as unknown as { heightSamples: HeightSample[] }).heightSamples);
/** The 240ms close spends about 180ms between open and shut, so only a longer frame can skip all of it. */
const CLOSE_IN_BETWEEN_MS = 175;

/** Opens the sidebar on the fixture's space, with motion on so carried rows close as users see them. */
async function withSidebar(
  run: (sidebar: { fixture: Fixture; page: Page; worker: Worker }) => Promise<void>,
): Promise<void> {
  await withExtension('multi-drag', async ({ context, worker }) => {
    const fixture = await createFixture(worker);
    const page = await openSidepanel(context, worker, { width: 900, height: 900 });
    await expect(row(page, fixture.folderId)).toBeVisible();
    await run({ fixture, page, worker });
  }, { reducedMotion: 'no-preference' });
}

/** Carries the drag over the folder until it shows the drop going inside. */
async function holdOverFolder(page: Page, fixture: Fixture): Promise<void> {
  const folder = (await row(page, fixture.folderId).boundingBox())!;
  await page.mouse.move(folder.x + folder.width / 2, folder.y + folder.height / 2, { steps: 8 });
  await expect(page.locator(`[data-bookmark-node-id="${fixture.folderId}"]`).first())
    .toHaveClass(/drop-inside/);
}

const folderChildIds = async (worker: Worker, fixture: Fixture) =>
  (await bookmarkChildren(worker, fixture.folderId)).map((child) => child.id);

test('a drag carrying several rows closes them all, and they land together', async () => {
  await withSidebar(async ({ fixture, page, worker }) => {
    await row(page, fixture.alphaId).click({ modifiers: ['ControlOrMeta'] });
    await row(page, fixture.gammaId).click({ modifiers: ['ControlOrMeta'] });
    await expect(row(page, fixture.alphaId)).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, fixture.gammaId)).toHaveAttribute('aria-selected', 'true');
    const openHeight = (await listItem(page, fixture.alphaId).boundingBox())!.height;

    await sampleHeights(page, fixture.alphaId, 2_000);
    await pressAndPull(page, row(page, fixture.gammaId), 3);
    await expect(page.locator(`[data-bookmark-node-id="${fixture.gammaId}"]`).first())
      .toHaveClass(/is-dragging/);

    // The row the drag did not grab closes too, fading and shrinking rather than vanishing.
    await expect(listItem(page, fixture.alphaId)).toHaveCSS('height', '0px');
    await expect(listItem(page, fixture.alphaId)).toHaveCSS('opacity', '0');
    await expect(listItem(page, fixture.betaId)).not.toHaveCSS('height', '0px');
    await expect.poll(async () => (await heightSamples(page)).some((sample) => sample.height <= 1)).toBe(true);
    const closing = await heightSamples(page);
    // The first frame after the row was last fully open shows it part-way shut,
    // unless the page was too busy to draw any frame for most of the close.
    const lastOpen = closing.findLastIndex((sample) => sample.height >= openHeight - 1);
    const next = closing[lastOpen + 1]!;
    expect(next.height > 1 || next.at - closing[lastOpen]!.at > CLOSE_IN_BETWEEN_MS, JSON.stringify(closing))
      .toBe(true);

    // Drop targets below the closed rows are found where they now are.
    await holdOverFolder(page, fixture);
    await sampleHeights(page, fixture.alphaId, 400);
    await page.mouse.up();

    await expect.poll(() => folderChildIds(worker, fixture))
      .toEqual([fixture.alphaId, fixture.gammaId]);
    // A carried row does not open again where it was before it goes.
    await expect.poll(async () => (await heightSamples(page)).length).toBeGreaterThan(10);
    expect(Math.max(...(await heightSamples(page)).map((sample) => sample.height))).toBeLessThan(1);
  });
});

test('a selection whose last row sits just above an empty folder drops inside it', async () => {
  await withSidebar(async ({ fixture, page, worker }) => {
    await row(page, fixture.betaId).click({ modifiers: ['ControlOrMeta'] });
    await row(page, fixture.gammaId).click({ modifiers: ['ControlOrMeta'] });
    await pressAndPull(page, row(page, fixture.betaId), 3);
    await expect(listItem(page, fixture.gammaId)).toHaveCSS('height', '0px');

    // The carried Gamma closes over the folder, but is no longer a drop target.
    await holdOverFolder(page, fixture);
    await page.mouse.up();

    await expect.poll(() => folderChildIds(worker, fixture))
      .toEqual([fixture.betaId, fixture.gammaId]);
  });
});
