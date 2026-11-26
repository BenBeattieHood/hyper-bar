import { expect, test, type Worker } from '@playwright/test';
import { withProfile } from './helpers/extension';
import { selectSpace } from './helpers/sidebar';
import { createSecondSpace } from './helpers/spaces';
import { browserTab, createTab, pageAtUrl, queryTabs, tabOwnershipSummary } from './helpers/tabs';
import { allBookmarks } from './helpers/chrome';

const musicHost = 'https://music.test';

/** A player that changes song in place, as YouTube Music does: a new address and title, no page load. */
const musicPage = `<!doctype html><title>Music</title>
  <button id="start">Start</button>
  <audio loop></audio>
  <script>
    document.querySelector('#start').addEventListener('click', async () => {
      const rate = 8000;
      const buffer = new ArrayBuffer(44 + rate * 2);
      const view = new DataView(buffer);
      const write = (offset, value) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
      write(0, 'RIFF'); view.setUint32(4, 36 + rate * 2, true); write(8, 'WAVEfmt ');
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
      view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data');
      view.setUint32(40, rate * 2, true);
      for (let i = 0; i < rate; i += 1) view.setInt16(44 + i * 2, Math.sin(i * 0.3) * 12000, true);
      const audio = document.querySelector('audio');
      audio.src = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
      await audio.play();
    });
    globalThis.nextSong = (id) => {
      history.pushState({}, '', '/watch?v=' + id + '&list=LM');
      document.title = 'Song ' + id + ' | Music';
    };
  </script>`;

const musicTabs = async (worker: Worker) =>
  (await queryTabs(worker)).filter((tab) => (tab.pendingUrl ?? tab.url)?.startsWith(musicHost));

const musicBackings = async (worker: Worker) =>
  (await allBookmarks(worker)).filter((node) => node.url?.startsWith(musicHost)).map((node) => node.url);

test('a playing music tab that changes song is not reopened when its space returns', () => withProfile('music-space-switch', async (profile) => {
  test.setTimeout(60_000);
  const { context, page, worker } = await profile.launchHyper({ closeInitialPage: true, enableAudio: true });
  await context.route(`${musicHost}/**`, (route) => route.fulfill({ contentType: 'text/html', body: musicPage }));
  const musicTabId = await createTab(worker, `${musicHost}/watch?v=a&list=LM`);
  await expect.poll(() => tabOwnershipSummary(worker, [musicTabId])).toEqual({ allOwned: true, spaceCount: 1 });
  const music = await pageAtUrl(context, `${musicHost}/watch?v=a&list=LM`);
  await music.locator('#start').click();
  await expect.poll(async () => (await browserTab(worker, musicTabId)).audible).toBe(true);

  await createSecondSpace(worker);
  for (const [round, song] of ['b', 'c', 'd'].entries()) {
    await selectSpace(page, 'Second space');
    await music.evaluate((id) => (globalThis as unknown as { nextSong(id: string): void }).nextSong(id), song);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await selectSpace(page, 'Space 1');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect({ round, tabs: (await musicTabs(worker)).length, backings: await musicBackings(worker) })
      .toEqual({ round, tabs: 1, backings: [`${musicHost}/watch?v=${song}&list=LM`] });
  }
}));
