import { Import } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { BookmarkFolderOption } from '../../lib/bookmarks';
import { EditorDialog } from './EditorDialog';

export interface BookmarkImportDestination {
  rootId: string;
  label: string;
}

/** Asks where a chosen browser bookmark folder should be imported. */
export function BookmarkImportPrompt({
  destinations,
  folder,
  onClose,
  onImport,
}: {
  destinations: BookmarkImportDestination[];
  folder: BookmarkFolderOption;
  onClose(): void;
  onImport(destinationRootId: string): void;
}) {
  const [rootId, setRootId] = useState('');
  const selectRef = useRef<HTMLSelectElement>(null);
  const destination = destinations.find((candidate) => candidate.rootId === rootId);

  useEffect(() => {
    requestAnimationFrame(() => selectRef.current?.focus());
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!destination) return;
    onImport(destination.rootId);
    onClose();
  };

  return (
    <EditorDialog
      className="bookmark-import-prompt"
      labelId="bookmark-import-title"
      describedBy="bookmark-import-source"
      icon={<Import size={17} />}
      title={`Import ${folder.title}`}
      subtitle={<p id="bookmark-import-source">{folder.path}</p>}
      closeLabel="Close import"
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <label>
          <span>Destination space</span>
          <select
            ref={selectRef}
            value={destination?.rootId ?? ''}
            disabled={destinations.length === 0}
            onChange={(event) => setRootId(event.currentTarget.value)}
          >
            <option value="" disabled>
              {destinations.length === 0
                ? 'No import destinations are available'
                : 'Choose a space'}
            </option>
            {destinations.map((candidate) => (
              <option key={candidate.rootId} value={candidate.rootId}>
                {candidate.label}
              </option>
            ))}
          </select>
        </label>
        <div className="editor-actions">
          <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button" disabled={!destination}>Import</button>
        </div>
      </form>
    </EditorDialog>
  );
}
