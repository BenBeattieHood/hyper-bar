import {
  expect,
  test,
} from '@playwright/test';
import { waitForActivationQuiescence } from './fixtures/activation';
import { readActiveSpaceId, seedActiveSpaceId } from './fixtures/activeSpace';
import { saveHyperPreference } from './fixtures/preferences';
import { paintedCustomProperty } from './fixtures/styles';
import { createMotionFixture, launchMotionFixture, settleMotionFixture } from './helpers/motion';
import { clickSelectionWithModifierReleased, spaceDotById } from './helpers/sidebar';
import { routeTabThroughGroupChange, waitForTabSpaceGroup } from './helpers/spaces';
import type { ExtensionGlobal } from './helpers/extensionGlobal';
import { tabRowSelector } from './helpers/rows';
import { bookmarkChildren, callChrome } from './helpers/chrome';
import { openSidepanel, routeHtml, titledPage, withProfile } from './helpers/extension';
import { activateTab, activeTabId, createTab } from './helpers/tabs';

/**
 * Serialized into the worker and the sidebar page: holds `chrome.tabs.update`
 * activations of `staleTabId` until `hyperReleaseStaleTabFocus` is called.
 */
function holdTabFocus(staleTabId: number): void {
  const runtime = globalThis as unknown as ExtensionGlobal & {
    hyperReleaseStaleTabFocus?: () => void;
    hyperStaleTabFocusEntered?: boolean;
  };
  const originalUpdate = runtime.chrome.tabs.update.bind(runtime.chrome.tabs);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  runtime.hyperStaleTabFocusEntered = false;
  runtime.hyperReleaseStaleTabFocus = () => {
    release?.();
  };
  runtime.chrome.tabs.update = (async (tabId: number, options: { active?: boolean }) => {
    if (tabId === staleTabId && options.active) {
      runtime.hyperStaleTabFocusEntered = true;
      await gate;
    }
    return originalUpdate(tabId, options);
  }) as typeof runtime.chrome.tabs.update;
}

test('clears selected tabs only for extension-initiated activation', () => withProfile('tab-selection-activation', async (profile) => {
  const { fixture, page, worker } = await launchMotionFixture(profile, 'Tab selection activation fixture');
  await callChrome(worker, 'storage.session.set', { [`tabSpaceId:${fixture.secondTabId}`]: fixture.firstSpaceId });
  await openSidepanel(page, worker);
  const firstTab = page.locator(`${tabRowSelector(fixture.firstTabId)} .tab-main`);
  const secondTab = page.locator(`${tabRowSelector(fixture.secondTabId)} .tab-main`);
  const secondTabContent = page.locator(`${tabRowSelector(fixture.secondTabId)} .tab-content`);
  const activeRow = page.locator(
    '.tab-row.is-active:not([data-tab-node-id^="unsupported-tab:"])',
  );
  const activeBrowserTabId = () => activeTabId(worker);

  await expect(firstTab).toBeVisible();
  await expect(secondTab).toBeVisible();
  await activateTab(worker, fixture.firstTabId);
  await expect(activeRow).toHaveAttribute('data-tab-id', String(fixture.firstTabId));
  // Reading the colour off the row would catch the fill mid-transition, so
  // the expected value comes from the token the row settles on.
  const activeBackground = await paintedCustomProperty(
    activeRow.locator('.tab-content'),
    '--row-active-background',
  );
  await expect(secondTabContent).not.toHaveCSS('background-color', activeBackground);
  await expect(activeRow.locator('.tab-content')).toHaveCSS(
    'background-color',
    activeBackground,
  );
  await expect(activeRow.locator('.tab-content')).toHaveCSS('box-shadow', 'none');
  await clickSelectionWithModifierReleased(page, firstTab);
  await clickSelectionWithModifierReleased(page, secondTab);
  await expect(firstTab).toHaveAttribute('aria-selected', 'true');
  await expect(secondTab).toHaveAttribute('aria-selected', 'true');

  await activateTab(worker, fixture.secondTabId);
  await expect(activeRow).toHaveAttribute('data-tab-id', String(fixture.secondTabId));
  await expect(firstTab).toHaveAttribute('aria-selected', 'true');
  await expect(secondTab).toHaveAttribute('aria-selected', 'true');
  await expect(activeRow.locator('.tab-content')).toHaveCSS(
    'background-color',
    activeBackground,
  );

  await firstTab.click();
  await expect(activeRow).toHaveAttribute('data-tab-id', String(fixture.firstTabId));
  await expect(firstTab).toHaveAttribute('aria-selected', 'false');
  await expect(secondTab).toHaveAttribute('aria-selected', 'false');

  await clickSelectionWithModifierReleased(page, firstTab);
  await clickSelectionWithModifierReleased(page, secondTab);
  await page.getByRole('button', { name: 'Search tabs and history' }).click();
  const commandInput = page.getByRole('combobox', {
    name: 'Search tabs, bookmarks, history, or commands',
  });
  await commandInput.fill('Switch to next tab');
  await expect(page.locator('#command-result-command-next-tab')).toBeVisible();
  await commandInput.press('Enter');
  await expect.poll(activeBrowserTabId).toBe(fixture.secondTabId);
  await expect(activeRow).toHaveAttribute('data-tab-id', String(fixture.secondTabId));
  await expect(firstTab).toHaveAttribute('aria-selected', 'false');
  await expect(secondTab).toHaveAttribute('aria-selected', 'false');
}));

test('matches the browser active tab after rapid cross-space activation', () => withProfile('native-tab-activation', async (profile) => {
  const { fixture, page, worker } = await launchMotionFixture(profile, 'Native tab activation fixture');
  await openSidepanel(page, worker);

  const activeBrowserTabId = () => activeTabId(worker);
  const activeRow = page.locator(
    '.tab-row.is-active:not([data-tab-node-id^="unsupported-tab:"])',
  );
  const activeSpace = page.locator('.space-pagination-dot[aria-current="page"]');
  const settledActiveBackground = () => activeRow.locator('.tab-content').evaluate(
    async (content) => {
      const style = getComputedStyle(content);
      const milliseconds = (value: string) => value.endsWith('ms')
        ? Number.parseFloat(value)
        : Number.parseFloat(value) * 1_000;
      const durations = style.transitionDuration.split(',').map(milliseconds);
      const delays = style.transitionDelay.split(',').map(milliseconds);
      const transitionMs = Math.max(...durations.map(
        (duration, index) => duration + (delays[index % delays.length] ?? 0),
      ));
      if (transitionMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, transitionMs + 34));
      }
      return getComputedStyle(content).backgroundColor;
    },
  );

  await expect(activeSpace).toHaveAttribute('data-space-id', fixture.firstSpaceId);
  await page.getByRole('button', { name: 'Open Second space' }).click();
  await waitForActivationQuiescence(worker);
  await expect.poll(activeBrowserTabId).toBe(fixture.secondTabId);
  await expect(activeSpace).toHaveAttribute('data-space-id', fixture.secondSpaceId);
  await expect(activeRow).toHaveAttribute('data-tab-id', String(fixture.secondTabId));
  const activeBackground = await settledActiveBackground();
  await page.getByRole('button', { name: 'Open First space' }).click();
  await waitForActivationQuiescence(worker);
  await expect.poll(activeBrowserTabId).toBe(fixture.firstTabId);
  await expect(activeSpace).toHaveAttribute('data-space-id', fixture.firstSpaceId);
  await expect(activeRow).toHaveAttribute('data-tab-id', String(fixture.firstTabId));
  expect(await settledActiveBackground()).toBe(activeBackground);

  await worker.evaluate(async ({ firstTabId, secondTabId }) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    await extension.chrome.tabs.update(secondTabId, { active: true });
    await extension.chrome.tabs.update(firstTabId, { active: true });
    await extension.chrome.tabs.update(secondTabId, { active: true });
  }, fixture);

  await waitForActivationQuiescence(worker);
  await expect.poll(activeBrowserTabId).toBe(fixture.secondTabId);
  await expect(activeSpace).toHaveAttribute('data-space-id', fixture.secondSpaceId);
  await expect(activeRow).toHaveAttribute('data-tab-id', String(fixture.secondTabId));
  await expect.poll(() => worker.evaluate(async ({ firstTabId, secondTabId }) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const [firstTab, secondTab] = await Promise.all([
      extension.chrome.tabs.get(firstTabId),
      extension.chrome.tabs.get(secondTabId),
    ]);
    const [firstGroup, secondGroup] = await Promise.all([
      extension.chrome.tabGroups.get(firstTab.groupId),
      extension.chrome.tabGroups.get(secondTab.groupId),
    ]);
    return {
      firstGroupCollapsed: firstGroup.collapsed,
      secondGroupCollapsed: secondGroup.collapsed,
    };
  }, fixture)).toEqual({
    firstGroupCollapsed: true,
    secondGroupCollapsed: false,
  });
}));

test('conflicting tab and space focus intents converge on the latest space', () => withProfile('conflicting-tab-space-focus', async (profile) => {
  const { fixture, page, worker } = await launchMotionFixture(profile, 'Conflicting focus fixture');
  await settleMotionFixture(worker, fixture);
  await openSidepanel(page, worker);

  await page.getByRole('button', { name: 'Open Second space' }).click();
  await expect(page.locator('.space-pagination-dot[aria-current="page"]'))
    .toHaveAttribute('data-space-id', fixture.secondSpaceId);
  await expect(page.locator(`.tab-row[data-tab-id="${fixture.nestedTabId}"]`))
    .toBeVisible();

  // Tab activation is an intent, so the stale focus is held where the browser
  // is actually driven rather than where the click was made.
  await worker.evaluate(holdTabFocus, fixture.nestedTabId);
  await page.evaluate(holdTabFocus, fixture.nestedTabId);

  await page.locator(
    `.tab-row[data-tab-id="${fixture.nestedTabId}"] .tab-main`,
  ).click();
  await expect.poll(() => worker.evaluate(() =>
    (globalThis as unknown as { hyperStaleTabFocusEntered?: boolean })
      .hyperStaleTabFocusEntered === true)).toBe(true);
  await page.evaluate(() => {
    const clickSpace = (label: string) => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((candidate) => candidate.getAttribute('aria-label') === label);
      if (!button) throw new Error(`${label} was not found.`);
      button.click();
    };
    clickSpace('Open First space');
    clickSpace('Open Second space');
    clickSpace('Open First space');
  });
  await expect(page.locator('.space-pagination-dot[aria-current="page"]'))
    .toHaveAttribute('data-space-id', fixture.firstSpaceId);

  const windowId = await worker.evaluate(async () => {
    const extension = globalThis as unknown as ExtensionGlobal;
    return (await extension.chrome.windows.getCurrent()).id;
  });
  if (windowId === undefined) throw new Error('The fixture window was not found.');
  await Promise.race([
    expect.poll(async () => {
      const [tabState, storedSpaceId] = await Promise.all([
        worker.evaluate(async (firstTabId) => {
          const extension = globalThis as unknown as ExtensionGlobal;
          const tab = await extension.chrome.tabs.get(firstTabId);
          const group = tab.groupId < 0
            ? undefined
            : await extension.chrome.tabGroups.get(tab.groupId);
          return {
            active: tab.active,
            collapsed: group?.collapsed,
          };
        }, fixture.firstTabId),
        readActiveSpaceId(worker, windowId),
      ]);
      return {
        active: tabState.active,
        collapsed: tabState.collapsed,
        storedSpaceId,
        targetSpaceId: fixture.firstSpaceId,
      };
    }, { timeout: 1_500 }).toEqual({
      active: true,
      collapsed: false,
      storedSpaceId: fixture.firstSpaceId,
      targetSpaceId: fixture.firstSpaceId,
    }).catch(() => undefined),
    page.waitForTimeout(1_500),
  ]);
  await page.evaluate(() => {
    (globalThis as unknown as { hyperReleaseStaleTabFocus?: () => void })
      .hyperReleaseStaleTabFocus?.();
  });
  await worker.evaluate(() => {
    (globalThis as unknown as { hyperReleaseStaleTabFocus?: () => void })
      .hyperReleaseStaleTabFocus?.();
  });
  await expect.poll(async () => {
    const [state, storedSpaceId] = await Promise.all([
      worker.evaluate(async ({ firstSpaceId, windowId }) => {
        const extension = globalThis as unknown as ExtensionGlobal;
        const [activeTab] = await extension.chrome.tabs.query({ active: true, windowId });
        if (activeTab?.id === undefined) return undefined;
        const [ownership, groups] = await Promise.all([
          extension.chrome.storage.session.get(`tabSpaceId:${activeTab.id}`),
          extension.chrome.tabGroups.query({ windowId }),
        ]);
        const activeGroup = groups.find((group) => group.id === activeTab.groupId);
        const activeTabOwnership = ownership[`tabSpaceId:${activeTab.id}`] as
          | { spaceId?: unknown }
          | undefined;
        return {
          activeGroupCollapsed: activeGroup?.collapsed,
          activeTabSpaceId: activeTabOwnership?.spaceId,
          inactiveGroupsCollapsed: groups
            .filter((group) => group.id !== activeTab.groupId && group.title?.startsWith('hyper:'))
            .every((group) => group.collapsed),
          targetSpaceId: firstSpaceId,
        };
      }, {
        firstSpaceId: fixture.firstSpaceId,
        windowId,
      }),
      readActiveSpaceId(worker, windowId),
    ]);
    return state && { ...state, storedSpaceId };
  }).toEqual({
    activeGroupCollapsed: false,
    activeTabSpaceId: fixture.firstSpaceId,
    inactiveGroupsCollapsed: true,
    storedSpaceId: fixture.firstSpaceId,
    targetSpaceId: fixture.firstSpaceId,
  });
}));

test('expands nested open-tab folders on first pane reveal in a space', () => withProfile('open-tab-folders', async (profile) => {
  const { fixture, page, worker } = await launchMotionFixture(profile, 'Open tab folder fixture');
  await saveHyperPreference(worker, 'autofolders', false);
  await openSidepanel(page, worker);
  await routeTabThroughGroupChange(worker, fixture.firstTabId, fixture.firstSpaceId);
  const createTabFolder = async (title: string, parentId?: string): Promise<string> => {
    const trigger = parentId
      ? page.locator(`[data-tab-node-id="${parentId}"]`).getByRole('button', {
        name: /^Create subfolder/,
      })
      : page.getByRole('button', { name: 'Create tab folder' });
    await trigger.click();
    const editor = page.getByRole('dialog');
    await editor.getByLabel('Title').fill(title);
    await editor.getByRole('button', { name: 'Save changes' }).click();
    await expect(editor).toHaveCount(0);
    const row = page.locator('.tab-folder-row').filter({ hasText: title });
    await expect(row).toBeVisible();
    const folderId = await row.getAttribute('data-tab-node-id');
    if (!folderId) throw new Error('Created tab folder has no node ID');
    return folderId;
  };
  const outerId = await createTabFolder('Open tab outer folder');
  const innerId = await createTabFolder('Open tab inner folder', outerId);
  const tabRow = page.locator(`.tab-row[data-tab-id="${fixture.firstTabId}"]`);
  const backingId = await tabRow.getAttribute('data-tab-node-id');
  if (!backingId) throw new Error('The routed tab has no backing ID');
  await callChrome(worker, 'bookmarks.move', backingId, { parentId: innerId });
  await expect.poll(async () => (await bookmarkChildren(worker, innerId))
    .some((node) => node.id === backingId)).toBe(true);
  const folderIds = { backingId, innerId, outerId };

  const outerFolder = page.locator(
    `[data-tab-node-id="${folderIds.outerId}"] .folder-item`,
  );
  const innerFolder = page.locator(
    `[data-tab-node-id="${folderIds.innerId}"] .folder-item`,
  );
  await expect(outerFolder).toHaveAttribute('aria-expanded', 'true');
  await expect(innerFolder).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator(`.tab-row[data-tab-node-id="${folderIds.backingId}"]`))
    .toBeVisible();

  await innerFolder.click();
  await expect(innerFolder).toHaveAttribute('aria-expanded', 'false');
  await outerFolder.click();
  await expect(outerFolder).toHaveAttribute('aria-expanded', 'false');
  await spaceDotById(page, fixture.secondSpaceId).click();
  await spaceDotById(page, fixture.firstSpaceId).click();

  await expect(outerFolder).toHaveAttribute('aria-expanded', 'true');
  await expect(innerFolder).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator(`.tab-row[data-tab-node-id="${folderIds.backingId}"]`))
    .toBeVisible();
}));

test('assigns an ungrouped attached tab to the destination active space', () => withProfile('attached-tab-space', async (profile) => {
  const { context, worker } = await profile.launchExtension();
  await routeHtml(context, 'https://motion.test/**', titledPage('Attached tab fixture'));
  const fixture = await createMotionFixture(worker);
  const transfer = await worker.evaluate(async ({ secondSpaceId }) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const movingTab = await extension.chrome.tabs.create({
      active: true,
      url: 'https://motion.test/attached-tab',
    });
    if (movingTab.id === undefined) throw new Error('The moving tab was not created');
    const destination = await extension.chrome.windows.create({
      focused: true,
      url: 'about:blank',
    });
    if (destination?.id === undefined) {
      throw new Error('The destination window was not created');
    }
    return {
      destinationWindowId: destination.id,
      movingTabId: movingTab.id,
      secondSpaceId,
    };
  }, fixture);
  await seedActiveSpaceId(worker, transfer.destinationWindowId, transfer.secondSpaceId);
  const destinationTabId = await createTab(worker, 'about:blank', { windowId: transfer.destinationWindowId });
  await waitForTabSpaceGroup(worker, destinationTabId, transfer.secondSpaceId);
  const readTargetGroupId = () => worker.evaluate(async ({
    destinationWindowId,
    secondSpaceId,
  }) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const key = `spaceGroupId:${destinationWindowId}:${secondSpaceId}`;
    const stored = await extension.chrome.storage.session.get(key);
    return typeof stored[key] === 'number' ? stored[key] : undefined;
  }, transfer);
  await expect.poll(readTargetGroupId).not.toBeUndefined();
  const targetGroupId = await readTargetGroupId();
  await worker.evaluate(async ({ movingTabId, destinationWindowId }) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const movingTab = await extension.chrome.tabs.get(movingTabId);
    await extension.chrome.windows.update(movingTab.windowId, { focused: true });
    await extension.chrome.tabs.update(movingTabId, { active: true });
    await extension.chrome.tabs.ungroup(movingTabId);
    await extension.chrome.tabs.move(movingTabId, {
      index: -1,
      windowId: destinationWindowId,
    });
    // A dragged tab arrives focused, so its activation races its attachment.
    await extension.chrome.tabs.update(movingTabId, { active: true });
  }, transfer);
  await expect.poll(() => worker.evaluate(async ({ movingTabId }) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const storageKey = `tabSpaceId:${movingTabId}`;
    const [tab, tabValue, stored] = await Promise.all([
      extension.chrome.tabs.get(movingTabId),
      extension.chrome.sessions?.getTabValue?.(movingTabId, 'hyperSpaceId'),
      extension.chrome.storage.session.get(storageKey),
    ]);
    const ownership = tabValue ?? stored[storageKey];
    return {
      active: tab.active,
      groupId: tab.groupId,
      spaceId: (ownership as { spaceId?: string } | undefined)?.spaceId,
      windowId: tab.windowId,
    };
  }, transfer), { timeout: 20_000 }).toEqual({
    active: true,
    groupId: targetGroupId,
    spaceId: transfer.secondSpaceId,
    windowId: transfer.destinationWindowId,
  });
}));

test('browser activation wins when it overlaps a sidebar space selection', () => withProfile('overlapping-tab-activation', async (profile) => {
  const { context, worker } = await profile.launchExtension({ closeInitialPage: true });
  const page = await context.newPage();
  const fixture = await createMotionFixture(worker);
  await openSidepanel(page, worker);
  await waitForTabSpaceGroup(worker, fixture.firstTabId, fixture.firstSpaceId);
  await waitForTabSpaceGroup(worker, fixture.secondTabId, fixture.secondSpaceId);
  const firstSpaceButton = page.getByRole('button', { name: 'Open First space' });
  const secondSpaceButton = page.getByRole('button', { name: 'Open Second space' });
  await secondSpaceButton.click();
  await expect(secondSpaceButton).toHaveAttribute('aria-current', 'page');
  await waitForActivationQuiescence(page);

  await worker.evaluate(({ firstTabId, secondTabId }) => {
    const extension = globalThis as unknown as ExtensionGlobal & {
      hyperOverlappingActivationTriggered?: boolean;
    };
    extension.hyperOverlappingActivationTriggered = false;
    const listener = (activeInfo: { tabId: number }) => {
      if (activeInfo.tabId !== firstTabId) return;
      extension.chrome.tabs.onActivated.removeListener(listener);
      extension.hyperOverlappingActivationTriggered = true;
      void extension.chrome.tabs.update(secondTabId, { active: true });
    };
    extension.chrome.tabs.onActivated.addListener(listener);
  }, fixture);
  await firstSpaceButton.click();
  await expect.poll(() => worker.evaluate(() =>
    (globalThis as unknown as { hyperOverlappingActivationTriggered?: boolean })
      .hyperOverlappingActivationTriggered === true)).toBe(true);
  await expect.poll(async () => {
    const [tabId, activeSpaceId] = await Promise.all([
      activeTabId(worker),
      readActiveSpaceId(worker, fixture.windowId),
    ]);
    return { activeSpaceId, activeTabId: tabId };
  }).toEqual({
    activeSpaceId: fixture.secondSpaceId,
    activeTabId: fixture.secondTabId,
  });
  await expect(secondSpaceButton).toHaveAttribute('aria-current', 'page');
}));
