import { useEffect, useState } from 'react';
import { errorMessage } from '../lib/notify';

export function InlineSpaceTitle({
  title,
  onSave,
  onError,
}: {
  title: string;
  onSave: (title: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState(title);

  useEffect(() => setDraft(title), [title]);

  const commit = async (value: string) => {
    const nextTitle = value.trim();
    if (!nextTitle || nextTitle === title) {
      setDraft(title);
      return;
    }
    setDraft(nextTitle);
    try {
      await onSave(nextTitle);
    } catch (error) {
      setDraft(title);
      onError(errorMessage(error, 'Space could not be renamed'));
    }
  };

  return (
    <input
      id="space-title"
      className="space-title-input"
      type="text"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => void commit(event.currentTarget.value)}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.currentTarget.value = title;
          setDraft(title);
          event.currentTarget.blur();
        }
      }}
      aria-label={`Rename ${title}`}
      title="Edit space name"
      spellCheck={false}
    />
  );
}
