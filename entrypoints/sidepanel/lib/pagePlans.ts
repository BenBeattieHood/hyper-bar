import type { useBrowserState } from '../hooks/useBrowserState';
import type { ClipboardPage } from './itemClipboard';
import { asBookmarkCreationResult } from './intentSubmission';
import type { Notify } from './notify';

/**
 * Pages Hyper has no row for, such as pasted or dropped addresses, and where
 * they go: bookmarked into a folder, or opened as tabs in a space.
 */
export type PagePlan =
  | {
      /** Each page's favourites bar slot, in order, when they are pinned. */
      favouriteSlots?: readonly number[];
      /** Where the first page goes in the folder; the rest follow it. Omitted, they go last. */
      index?: number;
      kind: 'bookmark-pages';
      notice?: string;
      pages: readonly ClipboardPage[];
      parentId: string;
    }
  | {
      /** A single page opens in front, as a dropped bookmark does. */
      activate?: boolean;
      kind: 'open-pages';
      notice?: string;
      pages: readonly ClipboardPage[];
      /** The space the tabs open in; omitted, the active one. */
      spaceId?: string;
    };

export interface PagePlanDependencies {
  activeSpaceId: string | undefined;
  browserState: Pick<ReturnType<typeof useBrowserState>, 'submitSelection'>;
  showNotice: Notify;
}

/** Sends a page plan as one intent, and says when nothing came of it. */
export async function carryOutPagePlan(plan: PagePlan, dependencies: PagePlanDependencies): Promise<void> {
  const { activeSpaceId, browserState, showNotice } = dependencies;
  if (plan.kind === 'bookmark-pages') {
    const results = await browserState.submitSelection('createBookmark', plan.pages.map((page, offset) => {
      const favouriteSlot = plan.favouriteSlots?.[offset];
      return {
        page,
        parentId: plan.parentId,
        ...(plan.index === undefined ? {} : { index: plan.index + offset }),
        ...(favouriteSlot === undefined ? {} : { favouriteSlot }),
      };
    }));
    if (!results.some((result) => asBookmarkCreationResult(result)?.created)) {
      showNotice(plan.pages.length === 1
        ? 'That page is already bookmarked here'
        : 'Those pages are already bookmarked here', 'warning');
    } else if (plan.notice) {
      showNotice(plan.notice, 'info');
    }
    return;
  }
  const spaceId = plan.spaceId ?? activeSpaceId;
  if (!spaceId) return;
  await browserState.submitSelection('openBookmark', plan.pages.map((page) => ({
    active: Boolean(plan.activate) && plan.pages.length === 1,
    destinationSpaceId: spaceId,
    forceNew: true,
    reuse: 'browser' as const,
    url: page.url,
  })));
  if (plan.notice) showNotice(plan.notice, 'info');
}
