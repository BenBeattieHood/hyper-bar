export type TreeDropPosition = 'before' | 'inside' | 'after';

export interface TreeDropIndicator {
  nodeId: string;
  /** `split` shows a tab beside the one dropped on, in the browser's split view. */
  position: TreeDropPosition | 'split';
  invalid: boolean;
  depth?: number;
}

export type DragItemData =
  | {
      kind: 'tree';
      nodeId: string;
      title: string;
      parentId: string;
      index: number;
      depth: number;
      isFolder: boolean;
      ancestorIds?: string[];
      itemCount?: number;
    }
  | {
      kind: 'favourite';
      nodeId: string;
      title: string;
      index: number;
      itemCount?: number;
    }
  | {
      kind: 'favourite-zone';
    }
  | {
      kind: 'favourite-slot';
      index: number;
    }
  | {
      kind: 'tree-zone';
      parentId: string;
      index?: number;
    }
  | {
      kind: 'space';
      spaceId: string;
      rootId?: string;
      /** A row in the archived spaces list rather than a pagination dot. */
      archived?: true;
    }
  | {
      /** The pagination's button for the archived spaces list. */
      kind: 'space-archive';
    }
  | {
      kind: 'trash';
    }
  | {
      kind: 'tab';
      tabId: number;
      title: string;
      windowId: number;
      index: number;
      bookmarkable: boolean;
      backingId?: string;
      nodeId?: string;
      parentId?: string;
      treeIndex?: number;
      depth?: number;
      ancestorIds?: string[];
      itemCount?: number;
    }
  | {
      kind: 'tab-folder';
      nodeId: string;
      title: string;
      parentId: string;
      index: number;
      depth: number;
      virtual?: boolean;
      ancestorIds?: string[];
      itemCount?: number;
    }
  | {
      kind: 'tabs-zone';
      parentId?: string;
      index?: number;
    }
  | {
      /** A tab another session keeps, by its backing. */
      kind: 'session-tab';
      installationId: string;
      nodeId: string;
      title: string;
      url?: string;
      itemCount?: number;
    }
  | {
      kind: 'session-zone';
      installationId: string;
    }
  | {
      kind: 'bookmarks-trigger';
    }
  | {
      kind: 'tabs-trigger';
    }
  | {
      /** The favourites bar's button for the bookmarks kept outside every space. */
      kind: 'global-bookmarks';
    }
  | {
      /**
       * Links, text, or files dragged in from outside Hyper. The browser shows
       * what they hold only once they are dropped, so this says only how many
       * files there are.
       */
      kind: 'external';
      files: number;
      itemCount: number;
      title: string;
    };

export type SelectableDragItem = Extract<
  DragItemData,
  { kind: 'tree' | 'favourite' | 'tab' | 'tab-folder' | 'session-tab' }
>;