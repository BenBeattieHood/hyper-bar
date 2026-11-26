import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { trapDialogFocus } from '../lib/dialogFocus';

/** The modal frame shared by the editor and prompts: backdrop, focus trap and heading. */
export function EditorDialog({
  alert,
  children,
  className,
  closeLabel,
  describedBy,
  icon,
  labelId,
  onClose,
  subtitle,
  title,
}: {
  alert?: boolean;
  children: ReactNode;
  className?: string;
  /** Adds a close button to the heading. */
  closeLabel?: string;
  describedBy?: string;
  icon: ReactNode;
  labelId: string;
  onClose: () => void;
  subtitle?: ReactNode;
  title: ReactNode;
}) {
  const heading = <h2 id={labelId}>{title}</h2>;
  return (
    <div
      className="editor-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={className ? `bookmark-editor ${className}` : 'bookmark-editor'}
        role={alert ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        onKeyDown={(event) => trapDialogFocus(event, onClose)}
      >
        <div className="editor-heading">
          <span className="editor-heading-icon" aria-hidden="true">{icon}</span>
          {closeLabel ? (
            <>
              <div>{heading}{subtitle}</div>
              <button type="button" onClick={onClose} aria-label={closeLabel} title="Close">
                <X size={16} aria-hidden="true" />
              </button>
            </>
          ) : heading}
        </div>
        {children}
      </div>
    </div>
  );
}
