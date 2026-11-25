import { Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { bookmarkCount, visibleBookmarkTitle, type BookmarkNode } from '../../lib/bookmarks';
import { errorMessage } from '../lib/notify';
import { EditorDialog } from './EditorDialog';

export type SpaceDeletionChoice = 'cancel' | 'move' | 'skip';

interface PendingSpaceDeletion {
  bookmarkCount: number;
  node: BookmarkNode;
  title: string;
}

export interface SpaceDeletion {
  choose(choice: SpaceDeletionChoice): void;
  pending?: PendingSpaceDeletion;
  /** Deletes a space at once, or first asks what becomes of its bookmarks. */
  request(node: BookmarkNode): Promise<void>;
}

export function spaceDeletionQuestion(title: string, count: number): string {
  return count === 1
    ? `${title} has 1 bookmark. Move it to your default space?`
    : `${title} has ${count} bookmarks. Move these to your default space?`;
}

/** Asks before a space holding bookmarks is deleted whether they move to the default space. */
export function useSpaceDeletion(options: {
  bookmarksBySpaceId: Readonly<Record<string, readonly BookmarkNode[]>>;
  onCancel(spaceId: string): void;
  onDelete(node: BookmarkNode, choice: { moveBookmarks?: boolean }): Promise<void>;
  onNotice(message: string): void;
}): SpaceDeletion {
  const [pending, setPending] = useState<PendingSpaceDeletion>();
  return {
    choose: (choice) => {
      setPending(undefined);
      if (!pending) return;
      if (choice === 'cancel') {
        options.onCancel(pending.node.id);
        return;
      }
      void options.onDelete(pending.node, { moveBookmarks: choice === 'move' }).catch((error: unknown) =>
        options.onNotice(errorMessage(error, 'That space could not be deleted')));
    },
    pending,
    request: async (node) => {
      const count = bookmarkCount(options.bookmarksBySpaceId[node.id] ?? []);
      if (count === 0) return options.onDelete(node, {});
      setPending({ bookmarkCount: count, node, title: visibleBookmarkTitle(node) || 'Untitled space' });
    },
  };
}

export function SpaceDeletePrompt({ deletion }: { deletion: SpaceDeletion }) {
  const moveRef = useRef<HTMLButtonElement>(null);
  const { pending } = deletion;
  useEffect(() => {
    if (pending) requestAnimationFrame(() => moveRef.current?.focus());
  }, [pending]);
  if (!pending) return null;
  const cancel = () => deletion.choose('cancel');

  return (
    <EditorDialog
      alert
      className="space-delete-prompt"
      labelId="space-delete-title"
      describedBy="space-delete-question"
      icon={<Trash2 size={17} />}
      title={`Delete ${pending.title}`}
      onClose={cancel}
    >
      <div className="space-delete-body">
        <p id="space-delete-question">
          {spaceDeletionQuestion(pending.title, pending.bookmarkCount)}
        </p>
        <div className="editor-actions">
          <button
            ref={moveRef}
            type="button"
            className="primary-button"
            onClick={() => deletion.choose('move')}
          >
            Move
          </button>
          <button type="button" className="secondary-button" onClick={() => deletion.choose('skip')}>
            Skip
          </button>
          <button type="button" className="secondary-button" onClick={cancel}>Cancel</button>
        </div>
      </div>
    </EditorDialog>
  );
}
