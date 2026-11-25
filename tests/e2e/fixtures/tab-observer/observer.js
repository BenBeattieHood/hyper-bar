globalThis.hyperTabLifecycle = { created: [], removed: [], updated: [] };

chrome.tabs.onCreated.addListener((tab) => {
  globalThis.hyperTabLifecycle.created.push({
    groupId: tab.groupId,
    id: tab.id,
    url: tab.pendingUrl ?? tab.url,
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  globalThis.hyperTabLifecycle.removed.push(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.groupId === undefined && changeInfo.url === undefined) return;
  globalThis.hyperTabLifecycle.updated.push({
    ...(changeInfo.groupId === undefined ? {} : { groupId: changeInfo.groupId }),
    id: tabId,
    ...(changeInfo.url === undefined ? {} : { url: changeInfo.url }),
  });
});