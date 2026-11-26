import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { BookmarkCreateActions } from './BookmarkMenu';
import { BookmarkTree } from './BookmarkTree';
import { presenceMotion } from './WorkspaceMotion';
import type { useGlobalBookmarkTree } from '../hooks/useGlobalBookmarkTree';

type TreeProps = ComponentProps<typeof BookmarkTree>;

/** Where the reveal circle is centred, relative to the panel, and the radius that covers the whole panel. */
type Reveal = { x: number; y: number; radius: number };

const circle = (radius: number, { x, y }: Reveal) => `circle(${radius}px at ${x}px ${y}px)`;

/** A panel opens as a circle growing outwards from the button that controls it, and closes back into it. */
const panelVariants = {
  closed: (reveal: Reveal) => ({ clipPath: circle(0, reveal) }),
  open: (reveal: Reveal) => ({ clipPath: circle(reveal.radius, reveal) }),
};

function measureReveal(stack: HTMLElement, panelId: string): Reveal {
  const box = stack.getBoundingClientRect();
  const button = document.querySelector(`[aria-controls="${panelId}"]`)?.getBoundingClientRect();
  const x = button ? button.left + button.width / 2 - box.left : box.width;
  const y = button ? button.top + button.height / 2 - box.top : 0;
  const radius = Math.ceil(
    Math.max(...[0, box.width].flatMap((cx) => [0, box.height].map((cy) => Math.hypot(cx - x, cy - y)))),
  );
  return { x, y, radius };
}
const panelTransition = { type: 'tween' as const, duration: 0.26, ease: [0.2, 0, 0, 1] as const };

/**
 * Shows a panel in place of the active space's tabs and bookmarks. The space
 * stays beneath until the panel has covered it, and comes back before the panel
 * folds away, so neither ever leaves a gap.
 */
export function WorkspaceOverlayStack({
  actions,
  children,
  className,
  content,
  label,
  open,
  panelId,
  reduceMotion,
}: {
  /** Buttons beside the panel's title. */
  actions?: ReactNode;
  /** The space's own panel. */
  children: ReactNode;
  className?: string;
  /** What the panel shows; it stays shut without it. */
  content: ReactNode;
  label: string;
  open: boolean;
  panelId: string;
  reduceMotion: boolean;
}) {
  const [covered, setCovered] = useState(false);
  const stackRef = useRef<HTMLDivElement>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  // Measured before paint on every toggle, so the circle tracks the button even after the sidebar is resized.
  useLayoutEffect(() => {
    if (stackRef.current) setReveal(measureReveal(stackRef.current, panelId));
  }, [open]);
  useEffect(() => {
    if (!open) setCovered(false);
    else if (reduceMotion) setCovered(true);
  }, [open, reduceMotion]);

  return (
    <div className={`workspace-stack${covered ? ' is-covered' : ''}`} ref={stackRef}>
      {!covered && children}
      <AnimatePresence initial={false} custom={reveal}>
        {open && content && reveal && (
          <motion.section
            key={panelId}
            id={panelId}
            className={`space-panel${className ? ` ${className}` : ''} workspace-overlay-panel`}
            aria-label={label}
            custom={reveal}
            variants={panelVariants}
            animate="open"
            {...presenceMotion(reduceMotion, 'closed', 'closed', panelTransition)}
            // Only the opening animation may cover the space.
            onAnimationComplete={(definition) => {
              if (definition === 'open') setCovered(true);
            }}
          >
            <div className="workspace-view-toolbar is-combined workspace-overlay-toolbar">
              <h2 className="workspace-overlay-title">{label}</h2>
              {actions}
            </div>
            <div className="workspace-view-content">{content}</div>
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  );
}

/** The bookmarks kept outside every space, over the active space. */
export function GlobalBookmarksStack({
  actionsDisabled,
  children,
  onCreateFolder,
  onImportFolder,
  open,
  reduceMotion,
  spaceTreeProps,
  tree,
}: {
  actionsDisabled?: boolean;
  /** The space's own panel. */
  children: ReactNode;
  onCreateFolder(parentId: string): void;
  onImportFolder(folderId: string, parentId: string): void;
  open: boolean;
  reduceMotion: boolean;
  /** The space's tree, whose behaviour the global tree shares. */
  spaceTreeProps: TreeProps;
  tree: ReturnType<typeof useGlobalBookmarkTree>;
}) {
  const { rootId } = tree;
  return (
    <WorkspaceOverlayStack
      className="global-bookmarks-panel"
      label="Global bookmarks"
      open={open}
      panelId="global-bookmarks-panel"
      reduceMotion={reduceMotion}
      actions={rootId && (
        <BookmarkCreateActions
          disabled={actionsDisabled}
          buttonClassName="section-add-button workspace-view-add"
          groupLabel="Create global bookmark items"
          folderLabel="Create global bookmark folder"
          onCreateFolder={() => onCreateFolder(rootId)}
        />
      )}
      content={rootId && (
        <section className="bookmarks-section workspace-view-panel">
          <BookmarkTree
            {...spaceTreeProps}
            items={tree.items}
            matchingTabsByBookmarkId={tree.matchingTabsByBookmarkId}
            nodes={tree.nodes}
            onImportFolder={(folderId) => onImportFolder(folderId, rootId)}
            rootId={rootId}
            spaceIdsByPageIdentity={tree.spaceIdsByPageIdentity}
          />
        </section>
      )}
    >
      {children}
    </WorkspaceOverlayStack>
  );
}
