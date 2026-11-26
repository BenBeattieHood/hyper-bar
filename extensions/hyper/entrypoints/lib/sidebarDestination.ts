/**
 * Asks the browser sidebar of a window to show a destination, retrying while it
 * loads. Only that window's own sidebar answers.
 */
export async function showSidebarDestination(
  windowId: number,
  destination: 'tabs' | 'search',
): Promise<void> {
  const type = destination === 'search' ? 'hyper:show-search' : 'hyper:show-tabs';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await browser.runtime.sendMessage({ type, windowId })
      .catch(() => undefined) as {
        destination?: string;
        type?: string;
        windowId?: number;
      } | undefined;
    if (
      response?.type === 'hyper:destination-shown' &&
      response.destination === destination &&
      response.windowId === windowId
    ) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('The Hyper sidebar did not become ready.');
}
