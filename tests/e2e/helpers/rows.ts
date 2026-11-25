/** Selector for the sidebar row of a supported (not placeholder) browser tab. */
export function tabRowSelector(tabId: number): string {
  return `.tab-row[data-tab-id="${tabId}"]:not([data-tab-node-id^="unsupported-tab:"])`;
}
