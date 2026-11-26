import { useEffect, useState } from 'react';
import { errorMessage } from '../lib/notify';
import { listen } from '../lib/listen';

export type BookmarkSyncAction =
  | 'create'
  | 'remove'
  | 'open'
  | 'update'
  | 'revert';

type BookmarkSyncBaseAction = Exclude<BookmarkSyncAction, 'revert'>;

function primaryModifierPressed(event: { ctrlKey: boolean; metaKey: boolean }) {
  return event.ctrlKey || event.metaKey;
}

function BookmarkSyncIcon({ action }: { action: BookmarkSyncAction }) {
  const state = action === 'create'
    ? 'add'
    : action === 'remove'
      ? 'bookmarked'
      : action;
  return (
    <span
      className={`tab-bookmark-icon is-${state}`}
      data-bookmark-icon-state={state}
      aria-hidden="true"
    >
      {state === 'open' ? (
        <span className="tab-bookmark-open-dot" />
      ) : (
        <BookmarkSyncArtwork state={state} />
      )}
    </span>
  );
}

function BookmarkSyncArtwork({
  state,
}: {
  state: 'add' | 'bookmarked' | 'revert' | 'update';
}) {
  // Drawn rather than composed from icon glyphs so each state reads as one mark.
  const artwork = state === 'add'
    ? (
      <>
        <path d="M 380.856 235.462 L 380.856 241.377" />
        <path d="M 383.812 238.419 L 377.9 238.419" />
        <path d="M 385.783 231.519 C 386.872 231.519 387.754 232.402 387.754 233.491 L 387.754 248.277 C 387.754 249.034 386.937 249.508 386.28 249.133 L 381.834 246.591 C 381.229 246.245 380.485 246.245 379.879 246.591 L 375.433 249.133 C 374.777 249.508 373.96 249.034 373.959 248.277 L 373.959 233.491 C 373.959 232.402 374.842 231.519 375.93 231.519 L 385.783 231.519 Z" />
      </>
    )
    : state === 'bookmarked'
      ? (
        <path
          fillRule="evenodd"
          d="M 411.255 230.932 C 412.36 230.932 413.255 231.827 413.255 232.932 L 413.255 247.932 C 413.255 248.699 412.426 249.18 411.759 248.8 L 407.247 246.222 C 406.633 245.871 405.878 245.871 405.263 246.222 L 400.751 248.8 C 400.085 249.18 399.256 248.699 399.255 247.932 L 399.255 232.932 C 399.255 231.827 400.151 230.932 401.255 230.932 L 411.255 230.932 Z M 403.055 236.95 L 404.005 236 L 406.255 238.25 L 408.505 236 L 409.455 236.95 L 407.205 239.2 L 409.455 241.45 L 408.505 242.4 L 406.255 240.15 L 404.005 242.4 L 403.055 241.45 L 405.305 239.2 Z"
        />
      )
      : state === 'update'
        ? (
          <path
            fillRule="evenodd"
            d="M 437.247 231.31 C 438.352 231.31 439.247 232.205 439.247 233.31 L 439.247 248.31 C 439.247 249.077 438.418 249.558 437.751 249.178 L 433.239 246.6 C 432.625 246.249 431.87 246.249 431.255 246.6 L 426.743 249.178 C 426.077 249.558 425.248 249.077 425.247 248.31 L 425.247 233.31 C 425.247 232.205 426.143 231.31 427.247 231.31 L 437.247 231.31 Z M 429.519 239.564 C 429.333 239.748 429.197 239.976 429.124 240.228 L 428.472 242.466 C 428.47 242.472 428.469 242.477 428.468 242.483 C 428.396 242.774 428.667 243.034 428.955 242.95 L 431.191 242.297 C 431.443 242.223 431.672 242.088 431.858 241.903 L 435.772 237.993 C 436.19 237.575 436.354 236.965 436.201 236.394 C 435.871 235.163 434.334 234.75 433.432 235.651 L 429.519 239.564 Z"
          />
        )
        : (
          <>
            <path d="M 461.756 231.249 C 462.861 231.249 463.756 232.144 463.756 233.249 L 463.756 248.249 C 463.756 249.016 462.927 249.497 462.26 249.117 L 457.748 246.539 C 457.134 246.188 456.379 246.188 455.764 246.539 L 451.252 249.117 C 450.586 249.497 449.757 249.016 449.756 248.249 L 449.756 233.249 C 449.756 232.144 450.652 231.249 451.756 231.249 L 461.756 231.249 Z" />
            <path d="M 455.505 240.035 L 453.12 237.65 L 455.505 235.265 M 453.12 237.65 L 458.129 237.65 C 459.578 237.65 460.752 238.825 460.752 240.274 C 460.752 241.722 459.578 242.897 458.129 242.897 L 456.459 242.897" />
          </>
        );
  const viewBox = state === 'add'
    ? '373 230 15 20'
    : state === 'bookmarked'
      ? '399 230 15 20'
      : state === 'update' ? '425 230 15 20' : '449 230 15 20';
  return (
    <svg className="tab-bookmark-icon-artwork" viewBox={viewBox} aria-hidden="true">
      {artwork}
    </svg>
  );
}

/** Each action's accessible label for an item, tooltip and failure message. */
const ACTION_COPY: Record<BookmarkSyncAction, { label: (itemTitle: string) => string; title: string; failure: string }> = {
  create: {
    label: (itemTitle) => `Create bookmark for ${itemTitle}`,
    title: 'Create bookmark',
    failure: 'The bookmark could not be created',
  },
  open: {
    label: (itemTitle) => `Focus open tab for ${itemTitle}`,
    title: 'Focus open tab',
    failure: 'The open tab could not be focused',
  },
  remove: {
    label: (itemTitle) => `Remove bookmark for ${itemTitle}`,
    title: 'Remove bookmark',
    failure: 'The bookmark could not be removed',
  },
  revert: {
    label: (itemTitle) => `Revert ${itemTitle} to bookmarked page`,
    title: 'Revert tab to bookmarked page',
    failure: 'The tab could not be restored',
  },
  update: {
    label: (itemTitle) => `Update bookmark to ${itemTitle}`,
    title: 'Update bookmark to this page',
    failure: 'The bookmark could not be updated',
  },
};

export function BookmarkSyncButton({
  action,
  itemTitle,
  onAction,
  onError,
}: {
  action: BookmarkSyncBaseAction;
  itemTitle: string;
  onAction: (action: BookmarkSyncAction) => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [engaged, setEngaged] = useState(false);
  const [primaryModifierDown, setPrimaryModifierDown] = useState(false);
  const effectiveAction = action === 'update' && engaged && primaryModifierDown
    ? 'revert'
    : action;

  useEffect(() => {
    if (!engaged || action !== 'update') {
      setPrimaryModifierDown(false);
      return;
    }
    const updateModifier = (event: KeyboardEvent) => {
      setPrimaryModifierDown(primaryModifierPressed(event));
    };
    const clearModifier = () => setPrimaryModifierDown(false);
    return listen([window, 'keydown', updateModifier], [window, 'keyup', updateModifier], [window, 'blur', clearModifier]);
  }, [action, engaged]);

  const disengage = () => {
    setEngaged(false);
    setPrimaryModifierDown(false);
  };

  return (
    <button
      type="button"
      className={`tab-bookmark-indicator is-${effectiveAction}`}
      disabled={pending}
      onPointerEnter={(event) => {
        window.focus();
        event.currentTarget.focus({ preventScroll: true });
        setEngaged(true);
        setPrimaryModifierDown(primaryModifierPressed(event));
      }}
      onPointerMove={(event) => {
        if (document.activeElement !== event.currentTarget) {
          window.focus();
          event.currentTarget.focus({ preventScroll: true });
        }
        setPrimaryModifierDown(primaryModifierPressed(event));
      }}
      onPointerLeave={(event) => {
        if (document.activeElement === event.currentTarget) event.currentTarget.blur();
        disengage();
      }}
      onFocus={() => setEngaged(true)}
      onBlur={disengage}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        const selectedAction = action === 'update' && primaryModifierPressed(event)
          ? 'revert'
          : effectiveAction;
        setPending(true);
        void Promise.resolve()
          .then(() => onAction(selectedAction))
          .catch((error) => onError(errorMessage(error, ACTION_COPY[selectedAction].failure)))
          .finally(() => setPending(false));
      }}
      aria-label={ACTION_COPY[effectiveAction].label(itemTitle)}
      title={ACTION_COPY[effectiveAction].title}
    >
      <BookmarkSyncIcon action={effectiveAction} />
    </button>
  );
}