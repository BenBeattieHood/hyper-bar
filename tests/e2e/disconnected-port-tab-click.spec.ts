import { expect, test } from '@playwright/test';
import { withHyper } from './helpers/extension';
import { createTab, activeTabId, currentWindowTabIds } from './helpers/tabs';
import { tabRowSelector } from './helpers/rows';

const pageUrl = 'https://space-race.test/one';

interface PortCapture {
  hyperPorts: Array<{ disconnect(): void; postMessage(message: unknown): void }>;
}

// Chrome can close the model port before the sidebar hears about it, after
// which posting throws "Attempted to use a disconnected port object". Closing
// the sidebar's own end reproduces exactly that: its onDisconnect never fires.
// That click provably never left, so the sidebar sends it again once reconnected.
test('a tab click on a closed model port still focuses its tab', async () => {
  await withHyper('disconnected-port', async ({ page: sidebar, worker }) => {
    await sidebar.addInitScript(() => {
      const runtime = (globalThis as unknown as { chrome: { runtime: { connect: (...args: unknown[]) => unknown } } })
        .chrome.runtime;
      const capture = globalThis as unknown as PortCapture;
      const connect = runtime.connect.bind(runtime);
      capture.hyperPorts = [];
      runtime.connect = (...args: unknown[]) => {
        const port = connect(...args) as PortCapture['hyperPorts'][number];
        capture.hyperPorts.push(port);
        return port;
      };
    });
    await sidebar.reload();

    const tabId = await createTab(worker, pageUrl);
    await createTab(worker, 'https://space-race.test/two');
    const tabsBefore = await currentWindowTabIds(worker);
    const row = sidebar.locator(tabRowSelector(tabId));
    await expect(row).toBeVisible();

    const error = await sidebar.evaluate(() => {
      const ports = (globalThis as unknown as PortCapture).hyperPorts;
      for (const port of ports) port.disconnect();
      try {
        ports.at(-1)?.postMessage({ type: 'resync' });
        return undefined;
      } catch (thrown) {
        return (thrown as Error).message;
      }
    });
    expect(error).toMatch(/^Attempt(?:ed|ing) to use a disconnected port object$/);

    await row.locator('.tab-main').click();

    await expect.poll(() => activeTabId(worker)).toBe(tabId);
    expect(await currentWindowTabIds(worker)).toEqual(tabsBefore);
    await expect(sidebar.getByText('Attempted to use a disconnected port object')).toHaveCount(0);
    await expect(sidebar.getByText('This tab could not be focused.')).toHaveCount(0);
  });
});
