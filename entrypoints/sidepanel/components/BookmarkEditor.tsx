import { ExternalLink, FolderClosed } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { errorMessage } from '../lib/notify';
import { visibleBookmarkTitle, type BookmarkNode } from '../../lib/bookmarks';
import { EditorDialog } from './EditorDialog';

export interface BookmarkEditorProps {
  node: BookmarkNode;
  creating?: 'folder' | 'space' | 'tab-folder';
  /** Names a space: a copy just made, which cancelling keeps as it is, or one being renamed. */
  space?: 'copy' | 'rename';
  onClose: () => void;
  onSave: (title: string, url?: string) => Promise<void>;
}

function editorHeading({ creating, node, space }: Pick<BookmarkEditorProps, 'creating' | 'node' | 'space'>) {
  if (creating) return `New ${creating === 'tab-folder' ? 'tab folder' : creating}`;
  if (space) return space === 'copy' ? 'Name the copy' : 'Rename space';
  return `Edit ${node.url ? 'bookmark' : 'folder'}`;
}

export function BookmarkEditor({ node, creating, space, onClose, onSave }: BookmarkEditorProps) {
  const [title, setTitle] = useState(visibleBookmarkTitle(node));
  const [url, setUrl] = useState(node.url ?? '');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => {
      titleRef.current?.focus();
      titleRef.current?.select();
    });
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const nextTitle = title.trim();
    const nextUrl = url.trim();
    // A bookmark with no title takes its page's; a folder has no page to take one from.
    if (!nextTitle && !node.url) {
      setError('Enter a title.');
      return;
    }
    if (node.url) {
      try {
        new URL(nextUrl);
      } catch {
        setError('Enter a complete URL, including its protocol.');
        return;
      }
    }
    setSaving(true);
    setError(undefined);
    try {
      await onSave(nextTitle, node.url ? nextUrl : undefined);
      onClose();
    } catch (saveError) {
      setError(errorMessage(saveError, 'Changes could not be saved.'));
      setSaving(false);
    }
  };

  return (
    <EditorDialog
      labelId="bookmark-editor-title"
      describedBy={error ? 'bookmark-editor-error' : undefined}
      icon={node.url ? <ExternalLink size={17} /> : <FolderClosed size={17} />}
      title={editorHeading({ creating, node, space })}
      subtitle={(
        <p>
          {node.url
            ? 'Change its visible title or destination.'
            : space === 'copy'
              ? `Cancel keeps the name ${visibleBookmarkTitle(node)}.`
              : 'Change its visible title.'}
        </p>
      )}
      closeLabel="Close editor"
      onClose={onClose}
    >
      <form onSubmit={(event) => void submit(event)}>
        <label>
          <span>Title</span>
          <input
            ref={titleRef}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoComplete="off"
          />
        </label>
        {node.url && (
          <label>
            <span>URL</span>
            <input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              autoComplete="url"
              spellCheck={false}
            />
          </label>
        )}
        {error && <p id="bookmark-editor-error" className="editor-error" role="alert">{error}</p>}
        <div className="editor-actions">
          <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      </form>
    </EditorDialog>
  );
}