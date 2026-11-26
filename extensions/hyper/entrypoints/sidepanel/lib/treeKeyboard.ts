export interface TreeKeyItem {
  ancestorIds: readonly string[];
  isFolder: boolean;
  nodeId: string;
}

export type TreeKeyAction =
  | { kind: 'activate'; nodeId: string }
  | { kind: 'collapse'; nodeId: string }
  | { kind: 'expand'; nodeId: string }
  | { kind: 'focus'; nodeId: string };

/**
 * What a key does on a row of a tree, as the WAI-ARIA tree pattern has it:
 * Up and Down step through the rows on show, Home and End go to the first and
 * last, Right opens a closed folder or steps into an open one, Left closes an
 * open folder or steps out to the folder holding the row, and Enter opens it.
 */
export function treeKeyAction(
  items: readonly TreeKeyItem[],
  nodeId: string,
  key: string,
  collapsed: (nodeId: string) => boolean,
): TreeKeyAction | undefined {
  const index = items.findIndex((item) => item.nodeId === nodeId);
  const item = items[index];
  if (!item) return undefined;
  const focus = (target: TreeKeyItem | undefined): TreeKeyAction | undefined =>
    target && target.nodeId !== nodeId ? { kind: 'focus', nodeId: target.nodeId } : undefined;
  if (key === 'ArrowDown') return focus(items[index + 1]);
  if (key === 'ArrowUp') return focus(items[index - 1]);
  if (key === 'Home') return focus(items[0]);
  if (key === 'End') return focus(items.at(-1));
  if (key === 'Enter') return { kind: 'activate', nodeId };
  if (key === 'ArrowRight') {
    if (!item.isFolder) return undefined;
    if (collapsed(nodeId)) return { kind: 'expand', nodeId };
    const next = items[index + 1];
    return next?.ancestorIds.includes(nodeId) ? focus(next) : undefined;
  }
  if (key === 'ArrowLeft') {
    if (item.isFolder && !collapsed(nodeId)) return { kind: 'collapse', nodeId };
    // A split view's panes sit in a folder that draws as their row, not as a row of its own.
    const listed = new Set(items.map((candidate) => candidate.nodeId));
    const parentId = item.ancestorIds.findLast((ancestorId) => listed.has(ancestorId));
    return parentId ? { kind: 'focus', nodeId: parentId } : undefined;
  }
  return undefined;
}

/** A character that types ahead: printable, and not one the sidebar keeps for itself. */
export function isTypeaheadKey(event: {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
}): boolean {
  return event.key.length === 1 && event.key !== ' ' && event.key !== '/' &&
    !event.altKey && !event.ctrlKey && !event.metaKey;
}

/**
 * The row typing ahead lands on: the next whose title starts with what was
 * typed, wrapping round. A longer string may stay on the row it already
 * matches, while one character, or the same one again, moves on to the next.
 */
export function typeaheadMatch(
  items: readonly { nodeId: string; title: string }[],
  nodeId: string | undefined,
  typed: string,
): string | undefined {
  const query = typed.toLocaleLowerCase();
  const [first] = query;
  if (!first || items.length === 0) return undefined;
  const repeated = [...query].every((character) => character === first);
  const prefix = repeated ? first : query;
  const current = items.findIndex((item) => item.nodeId === nodeId);
  const start = current < 0 ? 0 : current + (repeated ? 1 : 0);
  for (let step = 0; step < items.length; step += 1) {
    const item = items[(start + step) % items.length];
    if (item?.title.trimStart().toLocaleLowerCase().startsWith(prefix)) return item.nodeId;
  }
  return undefined;
}
