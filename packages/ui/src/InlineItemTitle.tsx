'use client';

import { useEffect, useRef, useState, type MouseEvent } from 'react';

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

export function titleClickIntervalStartsEditing(
  previousClickAt: number | undefined,
  clickAt: number,
): boolean {
  if (previousClickAt === undefined) return false;
  const interval = clickAt - previousClickAt;
  return interval > 200 && interval < 800;
}

export function useTitleDoubleClick() {
  const previousClickAt = useRef<number | undefined>(undefined);

  return (event: MouseEvent<HTMLElement>, enabled = true): boolean => {
    const clickedTitle = enabled &&
      event.target instanceof Element &&
      Boolean(event.target.closest('[data-item-title]'));
    if (!clickedTitle) {
      previousClickAt.current = undefined;
      return false;
    }
    const startsEditing = titleClickIntervalStartsEditing(
      previousClickAt.current,
      event.timeStamp,
    );
    previousClickAt.current = startsEditing ? undefined : event.timeStamp;
    return startsEditing;
  };
}

interface InlineItemTitleProps {
  allowBlank?: boolean;
  title: string;
  className: string;
  editing: boolean;
  onCancel: () => void;
  onSave: (title: string) => Promise<void>;
  onError?: (message: string) => void;
}

export function InlineItemTitle({
  allowBlank = false,
  title,
  className,
  editing,
  onCancel,
  onSave,
  onError,
}: InlineItemTitleProps) {
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const committing = useRef(false);

  useEffect(() => setDraft(title), [title]);
  useEffect(() => {
    if (!editing) return;
    setDraft(title);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [editing, title]);

  if (!editing) {
    return <span className={className} data-item-title="true">{title}</span>;
  }

  const commit = async () => {
    if (committing.current) return;
    const nextTitle = draft.trim();
    if ((!nextTitle && !allowBlank) || nextTitle === title) {
      onCancel();
      return;
    }
    committing.current = true;
    try {
      await onSave(nextTitle);
      onCancel();
    } catch (error) {
      setDraft(title);
      onCancel();
      onError?.(errorMessage(error, 'The title could not be changed'));
    } finally {
      committing.current = false;
    }
  };

  return (
    <input
      ref={inputRef}
      className={`${className} item-title-input`}
      type="text"
      value={draft}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={() => void commit()}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          setDraft(title);
          onCancel();
        }
      }}
      aria-label={`Rename ${title}`}
      spellCheck={false}
    />
  );
}
