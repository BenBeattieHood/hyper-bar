import { expect, test, type Worker } from '@playwright/test';
import { withProfile } from './helpers/extension';
import { selectSpace } from './helpers/sidebar';
import { createSecondSpace } from './helpers/spaces';
import { createTab, queryTabs, tabOwnershipSummary } from './helpers/tabs';
import { allBookmarks } from './helpers/chrome';

const musicTabs = async (worker: Worker) =>
  (await queryTabs(worker)).filter((tab) => (tab.pendingUrl ?? tab.url)?.includes('music.youtube.com'))
    .map((tab) => ({ id: tab.id, url: tab.url, title: tab.title, audible: tab.audible }));

const musicBackings = async (worker: Worker) =>
  (await allBookmarks(worker)).filter((node) => node.url?.includes('music.youtube.com'))
    .map((node) => ({ id: node.id, url: node.url, title: node.title, parentId: node.parentId }));

test('real youtube music survives space switches', () => withProfile('real-music', async (profile) => {
  test.setTimeout(120_000);
  const { context, page, worker } = await profile.launchHyper({ closeInitialPage: true, enableAudio: true });
  await context.unroute('https://space-race.test/**');
  const url = 'https://music.youtube.com/watch?v=4jBDnYE1WjI&list=LM';
  const musicTabId = await createTab(worker, url);
  await expect.poll(() => tabOwnershipSummary(worker, [musicTabId])).toEqual({ allOwned: true, spaceCount: 1 });
  const music = context.pages().find((candidate) => candidate.url().includes('music.youtube.com'))!;
  await music.waitForLoadState('load');
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  await music.mouse.click(10, 10).catch(() => undefined);
  await music.locator('#play-pause-button').click({ timeout: 10_000 }).catch((error) => console.log('play', String(error)));
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  console.log('initial', JSON.stringify({ tabs: await musicTabs(worker), backings: await musicBackings(worker) }));

  await createSecondSpace(worker);
  for (let round = 0; round < 3; round += 1) {
    await selectSpace(page, 'Second space');
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await selectSpace(page, 'Space 1');
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    console.log('round', round, JSON.stringify({ tabs: await musicTabs(worker), backings: await musicBackings(worker) }));
  }
  expect((await musicTabs(worker)).length).toBe(1);
}));
