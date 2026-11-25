/**
 * Opens a folder and every folder above it, so a row just made inside it
 * shows. Answers `collapsedIds` itself when none of them was closed, so React
 * keeps its state as it is.
 */
export function openFolderPath(
  collapsedIds: Set<string>,
  folderId: string,
  parentOf: (id: string) => string | undefined,
): Set<string> {
  const path = new Set<string>();
  for (let id: string | undefined = folderId; id && !path.has(id); id = parentOf(id)) {
    path.add(id);
  }
  return expandFolders(collapsedIds, path);
}

/** The collapsed folders with `folderIds` opened, the same set when none of them was collapsed. */
export function expandFolders(collapsedIds: Set<string>, folderIds: Iterable<string>): Set<string> {
  const opening = new Set(folderIds);
  if (![...opening].some((id) => collapsedIds.has(id))) return collapsedIds;
  return new Set([...collapsedIds].filter((id) => !opening.has(id)));
}

/** The collapsed folders with `folderId` opened if it was closed, or closed if it was open. */
export function toggleFolder(collapsedIds: ReadonlySet<string>, folderId: string): Set<string> {
  const next = new Set(collapsedIds);
  if (!next.delete(folderId)) next.add(folderId);
  return next;
}
