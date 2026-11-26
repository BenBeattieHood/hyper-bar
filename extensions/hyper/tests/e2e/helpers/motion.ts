import type { Locator, Page, Worker } from '@playwright/test';
import { seedActiveSpaceId } from '../fixtures/activeSpace';
import { localBookmarksRootId } from '../fixtures/localBookmarks';
import { callChrome, seedBookmarks, visibleTitle, type BookmarkNode } from './chrome';
import type { ExtensionGlobal } from './extensionGlobal';
import { routeHtml, titledPage, type ExtensionLaunchOptions, type Profile } from './extension';
import { activeTabId, createTabs, currentWindowId } from './tabs';

export interface MotionFixture {
  bookmarkId: string;
  favouritesId: string;
  firstTabId: number;
  firstSpaceId: string;
  innerBookmarkFolderId: string;
  nestedTabId: number;
  nestedBookmarkId: string;
  outerBookmarkFolderId: string;
  secondTabId: number;
  secondSpaceId: string;
  uiTabId: number;
  windowId: number;
}

export interface SpaceMotionSample {
  bookmarkControlLeft: number;
  bookmarkLeft: number;
  bookmarkSame: boolean;
  stripXs: Record<string, number>;
  tabXs: Record<string, number>;
}

interface CompactViewSample {
  bookmarkAnimations: string[];
  bookmarkPanels: number;
  tabAnimations: string[];
  tabPanels: number;
}

interface SettingsTransitionSample {
  backdropOpacity?: number;
  layerLeft: number;
}

interface SearchMorphSample {
  actionRight: number;
  resultsLeft?: number;
  visibleWidth: number;
}

export async function createMotionFixture(worker: Worker): Promise<MotionFixture> {
  const uiTabId = await activeTabId(worker);
  if (uiTabId === undefined) throw new Error('Chrome did not create the UI tab');
  await callChrome(worker, 'tabs.update', uiTabId, { pinned: true });
  const child = (node: BookmarkNode, title: string) =>
    node.children?.find((candidate) => visibleTitle(candidate.title) === title);
  const bookmarksRoot = (space: BookmarkNode) =>
    space.children?.find((node) => node.title.startsWith('bookmarks {'));
  // Build on the background's repaired structure rather than racing it with a second one.
  let hyper: BookmarkNode | undefined;
  for (let attempt = 0; attempt < 100 && !hyper; attempt += 1) {
    const bar = (await callChrome<BookmarkNode[]>(worker, 'bookmarks.getTree'))[0]?.children?.[0];
    const candidate = bar && child(bar, 'hyper');
    const spaces = candidate && child(candidate, 'spaces');
    if (spaces?.children?.some(bookmarksRoot)) hyper = candidate;
    else await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!hyper) throw new Error('Hyper did not repair its bookmark structure');
  const favourites = child(hyper, 'favourites')!;
  const spaces = child(hyper, 'spaces')!;
  const firstSpace = spaces.children!.find((node) => !node.url)!;
  await callChrome(worker, 'bookmarks.update', firstSpace.id, { title: 'First space' });
  const { secondSpace } = await seedBookmarks<'secondSpace'>(worker, [
    { key: 'secondSpace', title: 'Second space' },
  ], spaces.id);
  const sharedUrl = 'https://motion.test/shared';
  const nestedUrl = 'https://motion.test/nested';
  const bookmarks = await seedBookmarks<'bookmark' | 'innerFolder' | 'nested' | 'outerFolder'>(worker, [
    { key: 'bookmark', title: 'Shared motion bookmark', url: sharedUrl },
    {
      key: 'outerFolder',
      title: 'Open bookmark outer folder',
      children: [{
        key: 'innerFolder',
        title: 'Open bookmark inner folder',
        children: [{ key: 'nested', title: 'Nested open bookmark', url: nestedUrl }],
      }],
    },
  ], bookmarksRoot(firstSpace)!.id);
  const [firstTabId, secondTabId, nestedTabId] = await createTabs(
    worker,
    [sharedUrl, sharedUrl, nestedUrl],
    { active: false },
  ) as [number, number, number];
  const windowId = await currentWindowId(worker);
  await callChrome(worker, 'storage.session.set', {
    [`tabSpaceId:${firstTabId}`]: firstSpace.id,
    [`tabSpaceId:${secondTabId}`]: secondSpace,
    [`tabSpaceId:${nestedTabId}`]: secondSpace,
  });
  await seedActiveSpaceId(worker, windowId, firstSpace.id);
  return {
    bookmarkId: bookmarks.bookmark,
    favouritesId: favourites.id,
    firstTabId,
    firstSpaceId: firstSpace.id,
    innerBookmarkFolderId: bookmarks.innerFolder,
    nestedTabId,
    nestedBookmarkId: bookmarks.nested,
    outerBookmarkFolderId: bookmarks.outerFolder,
    secondTabId,
    secondSpaceId: secondSpace,
    uiTabId,
    windowId,
  };
}

/**
 * Launches Chromium, opens a 900px square page, serves `title` for the motion
 * hosts and creates the two-space motion fixture.
 */
export async function launchMotionFixture(
  profile: Profile,
  title: string,
  options?: ExtensionLaunchOptions,
) {
  const { context, worker } = await profile.launchExtension({ closeInitialPage: true, ...options });
  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 900 });
  await routeHtml(context, 'https://motion.test/**', titledPage(title));
  const fixture = await createMotionFixture(worker);
  return { context, fixture, page, worker };
}

/** Bookmarks belong to spaces, so this gives the second space its own copy of the shared page, returning its ID. */
export async function createSecondSpaceSharedBookmark(worker: Worker, fixture: MotionFixture): Promise<string> {
  const parentId = await localBookmarksRootId(worker, fixture.secondSpaceId);
  return (await callChrome<BookmarkNode>(worker, 'bookmarks.create', {
    parentId,
    title: 'Shared motion bookmark',
    url: 'https://motion.test/shared',
  })).id;
}

/**
 * At launch the background repairs its own canonical hyper bookmark structure -
 * including a default "Space 1" - which races with a fixture that writes spaces
 * directly. When the background wins, the reconciler merges the fixture's
 * First/Second spaces into the canonical spaces folder and deletes the duplicate
 * the fixture made, leaving the stray "Space 1" (and a chrome://newtab tab)
 * behind to claim the window. Tests whose assertions depend on the seeded First
 * space being current call this to settle that race: locate the canonical spaces
 * folder via the surviving First space, prune any space this fixture did not
 * create (only once both survivors are present, so the folder never empties and
 * re-triggers repair), drop stray new-tab pages, and keep the pinned UI tab
 * active so the seeded First space owns the window.
 */
export async function settleMotionFixture(
  worker: Worker,
  fixture: {
    firstSpaceId: string;
    secondSpaceId: string;
    uiTabId: number;
    windowId: number;
  },
): Promise<void> {
  await worker.evaluate(
    async ({ firstSpaceId, secondSpaceId, uiTabId, windowId }) => {
      interface BookmarkNode {
        id: string;
        url?: string;
        children?: BookmarkNode[];
      }
      const extension = globalThis as unknown as ExtensionGlobal;
      const keep = new Set([firstSpaceId, secondSpaceId]);
      const deadline = Date.now() + 8000;
      let stableReads = 0;
      let repairFailure: unknown;
      while (Date.now() < deadline && stableReads < 3) {
        const roots = await extension.chrome.bookmarks.getTree();
        const parents = new Map<string, BookmarkNode>();
        const record = (node: BookmarkNode) => {
          for (const child of node.children ?? []) {
            parents.set(child.id, node);
            record(child);
          }
        };
        for (const root of roots) record(root);
        // The First space always survives the merge, so its parent is the
        // canonical spaces folder wherever the reconciler settled it.
        const canonicalSpaces = parents.get(firstSpaceId);
        const spaceChildren = (canonicalSpaces?.children ?? []).filter(
          (node) => node.url === undefined,
        );
        const mergeComplete =
          spaceChildren.some((node) => node.id === firstSpaceId) &&
          spaceChildren.some((node) => node.id === secondSpaceId);
        let changed = !mergeComplete;
        if (mergeComplete) {
          for (const child of spaceChildren) {
            if (!keep.has(child.id)) {
              try {
                await extension.chrome.bookmarks.removeTree(child.id);
              } catch (error) {
                repairFailure = error;
              }
              changed = true;
            }
          }
        }
        const tabs = await extension.chrome.tabs.query({ windowId });
        for (const tab of tabs) {
          const url = tab.url ?? tab.pendingUrl ?? '';
          if (tab.id !== undefined && tab.pinned !== true && url.startsWith('chrome://newtab')) {
            try {
              await extension.chrome.tabs.remove(tab.id);
            } catch (error) {
              repairFailure = error;
            }
            changed = true;
          }
        }
        stableReads = changed ? 0 : stableReads + 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (stableReads < 3) {
        const suffix = repairFailure instanceof Error
          ? ` Latest repair failure: ${repairFailure.message}`
          : repairFailure === undefined
            ? ''
            : ` Latest repair failure: ${String(repairFailure)}`;
        throw new Error(`Motion fixture did not converge before its deadline.${suffix}`);
      }
      await extension.chrome.tabs.update(uiTabId, { active: true });
      const uiTab = (await extension.chrome.tabs.query({ windowId })).find(
        (tab) => tab.id === uiTabId,
      );
      if (!uiTab?.active) throw new Error('Motion fixture UI tab could not be activated.');
    },
    {
      firstSpaceId: fixture.firstSpaceId,
      secondSpaceId: fixture.secondSpaceId,
      uiTabId: fixture.uiTabId,
      windowId: fixture.windowId,
    },
  );
}

export async function sampleSpaceSwitch(
  page: Page,
  bookmarkId: string,
): Promise<SpaceMotionSample[]> {
  return page.evaluate((targetBookmarkId) =>
    new Promise<SpaceMotionSample[]>((resolveSamples) => {
      const bookmarkSection = document.querySelector<HTMLElement>(
        '#workspace-panel-bookmarks',
      );
      const switchButton = document.querySelector<HTMLButtonElement>(
        '.space-pagination-dot[aria-label="Open Second space"]',
      );
      if (!bookmarkSection || !switchButton) {
        throw new Error('Workspace transition fixture was not rendered');
      }
      const transformX = (element: Element): number => {
        const transform = getComputedStyle(element).transform;
        return transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m41;
      };
      const collectTransforms = (selector: string): Record<string, number> =>
        Object.fromEntries(Array.from(document.querySelectorAll<HTMLElement>(selector))
          .flatMap((element) => {
            const spaceId = element.dataset.spaceId;
            return spaceId ? [[spaceId, transformX(element)]] : [];
          }));
      const samples: SpaceMotionSample[] = [];
      const startedAt = performance.now();
      switchButton.click();
      const sample = () => {
        const currentBookmarkSection = document.querySelector<HTMLElement>(
          '#workspace-panel-bookmarks',
        );
        const bookmarkRow = document.querySelector<HTMLElement>(
          `[data-bookmark-node-id="${targetBookmarkId}"]`,
        );
        samples.push({
          bookmarkControlLeft: bookmarkRow?.querySelector<HTMLElement>(
            ':scope > .tab-bookmark-indicator',
          )?.getBoundingClientRect().left ?? -1,
          bookmarkLeft: currentBookmarkSection?.getBoundingClientRect().left ?? -1,
          bookmarkSame: currentBookmarkSection === bookmarkSection,
          stripXs: collectTransforms('.space-colour-strip'),
          tabXs: collectTransforms('.tabs-space-layer'),
        });
        if (performance.now() - startedAt < 420) requestAnimationFrame(sample);
        else resolveSamples(samples);
      };
      requestAnimationFrame(sample);
    }), bookmarkId);
}

export async function sampleCompactViewSwitch(
  page: Page,
  target: 'tabs' | 'bookmarks',
): Promise<CompactViewSample[]> {
  return page.evaluate((targetView) =>
    new Promise<CompactViewSample[]>((resolveSamples) => {
      const trigger = document.querySelector<HTMLButtonElement>(
        `.${targetView}-trigger`,
      );
      if (!trigger) throw new Error(`${targetView} trigger was not rendered`);
      const samples: CompactViewSample[] = [];
      const startedAt = performance.now();
      trigger.click();
      const animationNames = (selector: string) =>
        Array.from(document.querySelectorAll<HTMLElement>(selector))
          .map((element) => getComputedStyle(element).animationName);
      const sample = () => {
        samples.push({
          bookmarkAnimations: animationNames(
            '#workspace-panel-bookmarks .tree-list > li',
          ),
          bookmarkPanels: document.querySelectorAll(
            '#workspace-panel-bookmarks',
          ).length,
          tabAnimations: animationNames(
            '.tabs-space-layer .tree-list > li',
          ),
          tabPanels: document.querySelectorAll('.tabs-space-layer').length,
        });
        if (performance.now() - startedAt < 340) requestAnimationFrame(sample);
        else resolveSamples(samples);
      };
      requestAnimationFrame(sample);
    }), target);
}

export async function sampleSettingsTransition(
  page: Page,
  action: 'open' | 'close',
): Promise<SettingsTransitionSample[]> {
  return page.evaluate((transitionAction) =>
    new Promise<SettingsTransitionSample[]>((resolveSamples) => {
      const trigger = document.querySelector<HTMLButtonElement>(
        transitionAction === 'open'
          ? '.topbar button[aria-label="Open settings"]'
          : '.settings-layer button[aria-label="Back"]',
      );
      if (!trigger) throw new Error(`Settings ${transitionAction} trigger was not rendered`);
      const samples: SettingsTransitionSample[] = [];
      const startedAt = performance.now();
      trigger.click();
      const sample = () => {
        const layer = document.querySelector<HTMLElement>('.settings-layer');
        const backdrop = document.querySelector<HTMLElement>('.settings-backdrop');
        if (layer) {
          samples.push({
            backdropOpacity: backdrop
              ? Number.parseFloat(getComputedStyle(backdrop).opacity)
              : undefined,
            layerLeft: layer.getBoundingClientRect().left,
          });
        }
        if (performance.now() - startedAt < 340) requestAnimationFrame(sample);
        else resolveSamples(samples);
      };
      requestAnimationFrame(sample);
    }), action);
}

export async function sampleSearchMorph(
  page: Page,
  action: 'open' | 'close',
): Promise<SearchMorphSample[]> {
  return page.evaluate((transitionAction) =>
    new Promise<SearchMorphSample[]>((resolveSamples) => {
      const trigger = document.querySelector<HTMLButtonElement>('.search-command-action');
      if (!trigger) throw new Error(`Search ${transitionAction} trigger was not rendered`);
      const samples: SearchMorphSample[] = [];
      const startedAt = performance.now();
      trigger.click();
      const sample = () => {
        const control = document.querySelector<HTMLElement>('.search-command-shell');
        if (control) {
          const bounds = control.getBoundingClientRect();
          const clipPath = getComputedStyle(control, '::after').clipPath;
          const calculatedInset = /calc\(([-\d.]+)% - ([-\d.]+)px\)/.exec(clipPath);
          const directInset = /inset\([^ ]+ [^ ]+ [^ ]+ ([-\d.]+)(px|%)/.exec(clipPath);
          const leftInset = calculatedInset
            ? Number(calculatedInset[1]) * bounds.width / 100 - Number(calculatedInset[2])
            : Number(directInset?.[1] ?? 0) * (
                directInset?.[2] === '%' ? bounds.width / 100 : 1
              );
          const actionBounds = trigger.getBoundingClientRect();
          const resultsBounds = document.querySelector<HTMLElement>('.command-bar-results')
            ?.getBoundingClientRect();
          samples.push({
            actionRight: actionBounds.right,
            resultsLeft: resultsBounds?.left,
            visibleWidth: bounds.width - leftInset,
          });
        }
        if (performance.now() - startedAt < 340) requestAnimationFrame(sample);
        else resolveSamples(samples);
      };
      requestAnimationFrame(sample);
    }), action);
}

export function isMonotonic(
  values: number[],
  direction: 'increasing' | 'decreasing',
  tolerance = 0.5,
): boolean {
  return values.every((value, index) => index === 0 || (
    direction === 'increasing'
      ? value + tolerance >= values[index - 1]!
      : value - tolerance <= values[index - 1]!
  ));
}

interface HighlightExitSample {
  originX: number;
  scaleX: number;
  width: number;
}

/** Samples a hover highlight's horizontal scale for 220ms, starting immediately. */
export async function sampleHighlightEntry(
  highlight: Locator,
): Promise<{ originX: number; scales: number[]; width: number }> {
  return highlight.evaluate((element) =>
    new Promise<{ originX: number; scales: number[]; width: number }>((resolveSamples) => {
      const scales: number[] = [];
      const startedAt = performance.now();
      const sample = () => {
        const style = getComputedStyle(element);
        scales.push(style.transform === 'none'
          ? 1
          : Math.abs(new DOMMatrixReadOnly(style.transform).a));
        if (performance.now() - startedAt < 220) requestAnimationFrame(sample);
        else resolveSamples({
          originX: Number.parseFloat(style.transformOrigin),
          scales,
          width: element.getBoundingClientRect().width,
        });
      };
      sample();
    }));
}

/** Records a hover highlight every frame until it leaves the DOM; read with highlightExitSamples. */
export async function startHighlightExitSampling(highlight: Locator): Promise<void> {
  await highlight.evaluate((element) => {
    const target = globalThis as typeof globalThis & {
      paginationExitSamples?: HighlightExitSample[];
    };
    target.paginationExitSamples = [];
    const sample = () => {
      if (!element.isConnected) return;
      const style = getComputedStyle(element);
      target.paginationExitSamples?.push({
        originX: Number.parseFloat(style.transformOrigin),
        scaleX: style.transform === 'none'
          ? 1
          : Math.abs(new DOMMatrixReadOnly(style.transform).a),
        width: element.getBoundingClientRect().width,
      });
      requestAnimationFrame(sample);
    };
    sample();
  });
}

export async function highlightExitSamples(page: Page): Promise<HighlightExitSample[]> {
  return page.evaluate(() => {
    const target = globalThis as typeof globalThis & {
      paginationExitSamples?: HighlightExitSample[];
    };
    return target.paginationExitSamples ?? [];
  });
}
