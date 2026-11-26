import { LayoutGroup, motion, useReducedMotion } from 'motion/react';
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from 'react';
import type { Space } from '../../lib/bookmarks';
import { listen } from '../lib/listen';

const COLLAPSE_DISTANCE_PX = 20;
const SPACE_BUTTON_WIDTH_PX = 30;

interface SpaceIndicatorGroupProps {
  layoutGroupId?: string;
  spaces: readonly Pick<Space, 'id' | 'title'>[];
  spaceColours: Readonly<Record<string, string>>;
  groupLabel: string;
  summaryLabel: string;
  actionLabel: (space: Pick<Space, 'id' | 'title'>) => string;
  isForemost?: (space: Pick<Space, 'id' | 'title'>) => boolean;
  /** A middle-click closes the page in that space. */
  onClose?: (space: Pick<Space, 'id' | 'title'>) => void;
  onExpandedChange?: (expanded: boolean) => void;
  onSelect: (
    space: Pick<Space, 'id' | 'title'>,
    options: { moveToCurrentWindow: boolean },
  ) => void;
}

export function SpaceIndicatorGroup({
  layoutGroupId,
  spaces,
  spaceColours,
  groupLabel,
  summaryLabel,
  actionLabel,
  isForemost,
  onClose,
  onExpandedChange,
  onSelect,
}: SpaceIndicatorGroupProps) {
  const reduceMotion = useReducedMotion();
  const [expanded, setExpanded] = useState(false);
  const groupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstSpaceRef = useRef<HTMLButtonElement>(null);
  const restoreTriggerFocus = useRef(false);
  const spaceKey = spaces.map((space) => space.id).join(',');

  const updateExpanded = (nextExpanded: boolean) => {
    setExpanded(nextExpanded);
    onExpandedChange?.(nextExpanded);
  };
  const closeOnMiddleClick = (space: Pick<Space, 'id' | 'title'>) => (event: MouseEvent) => {
    if (event.button !== 1 || !onClose) return;
    event.preventDefault();
    event.stopPropagation();
    onClose(space);
  };

  useEffect(() => {
    updateExpanded(false);
  }, [spaceKey]);
  useEffect(() => {
    if (expanded) {
      firstSpaceRef.current?.focus();
    } else if (restoreTriggerFocus.current) {
      restoreTriggerFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [expanded]);
  useEffect(() => {
    if (!expanded) return;
    const onPointerMove = (event: globalThis.PointerEvent) => {
      const bounds = groupRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const horizontalDistance = Math.max(
        bounds.left - event.clientX,
        0,
        event.clientX - bounds.right,
      );
      const verticalDistance = Math.max(
        bounds.top - event.clientY,
        0,
        event.clientY - bounds.bottom,
      );
      if (Math.hypot(horizontalDistance, verticalDistance) > COLLAPSE_DISTANCE_PX) {
        restoreTriggerFocus.current = Boolean(
          groupRef.current?.contains(document.activeElement),
        );
        updateExpanded(false);
      }
    };
    return listen([document, 'pointermove', onPointerMove]);
  }, [expanded]);

  if (spaces.length === 0) return null;
  const joined = spaces.length > 1;
  const expandedWidth = spaces.length * SPACE_BUTTON_WIDTH_PX;
  const groupWidth = joined && expanded
    ? expandedWidth
    : SPACE_BUTTON_WIDTH_PX;
  const buttonMotion = {
    layout: reduceMotion ? false : 'position' as const,
    transition: { type: 'tween' as const, duration: reduceMotion ? 0 : 0.18 },
  };
  const spaceButton = (space: Pick<Space, 'id' | 'title'>, index: number) => (
    <motion.button
      ref={joined && index === 0 ? firstSpaceRef : undefined}
      key={space.id}
      type="button"
      className={`bookmark-space-link${isForemost?.(space) ? ' is-foremost' : ''}`}
      style={{ '--bookmark-space-colour': spaceColours[space.id] } as CSSProperties}
      {...buttonMotion}
      onClick={(event) => {
        if (joined) {
          restoreTriggerFocus.current = false;
          updateExpanded(false);
        }
        onSelect(space, { moveToCurrentWindow: event.metaKey || event.ctrlKey });
      }}
      onAuxClick={closeOnMiddleClick(space)}
      onMouseDown={(event) => event.button === 1 && event.preventDefault()}
      aria-label={actionLabel(space)}
    >
      <motion.span
        className="bookmark-space-indicator"
        layoutId={reduceMotion ? undefined : `space-${space.id}`}
        aria-hidden="true"
      />
    </motion.button>
  );

  const content = (
    <motion.div
        ref={groupRef}
        className={`bookmark-space-links${joined
          ? expanded
            ? ' is-expanded'
            : ' is-collapsed'
          : ' is-single'}`}
        role="group"
        aria-label={groupLabel}
        initial={false}
        animate={{ width: groupWidth }}
        transition={{
          type: 'tween',
          duration: reduceMotion ? 0 : 0.22,
          ease: [0.2, 0.75, 0.25, 1],
        }}
        onBlur={(event) => {
          if (joined && !event.currentTarget.contains(event.relatedTarget)) {
            updateExpanded(false);
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || !joined || !expanded) return;
          event.preventDefault();
          restoreTriggerFocus.current = true;
          updateExpanded(false);
        }}
      >
        {joined && !expanded ? (
          <motion.button
            ref={triggerRef}
            type="button"
            className="bookmark-space-link bookmark-space-summary"
            {...buttonMotion}
            onClick={() => updateExpanded(true)}
            aria-label={summaryLabel}
            aria-expanded="false"
            title={spaces.map((space) => space.title).join(', ')}
          >
            <span
              className="bookmark-space-summary-dots"
              style={{
                gridTemplateColumns: `repeat(${Math.ceil(Math.sqrt(spaces.length))}, 4px)`,
              }}
              aria-hidden="true"
            >
              {spaces.map((space) => (
                <span
                  key={space.id}
                  className="bookmark-space-summary-dot"
                  style={{
                    '--bookmark-space-colour': spaceColours[space.id],
                  } as CSSProperties}
                />
              ))}
            </span>
          </motion.button>
        ) : spaces.map(spaceButton)}
    </motion.div>
  );
  return layoutGroupId ? <LayoutGroup id={layoutGroupId}>{content}</LayoutGroup> : content;
}