import { useDndContext, useDroppable } from '@dnd-kit/core';
import {
  SortableContext,
  type SortingStrategy,
} from '@dnd-kit/sortable';
import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
  type HTMLMotionProps,
  type Variants,
} from 'motion/react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';

const staticTreeSortingStrategy: SortingStrategy = () => null;
const TreeMotionContext = createContext(true);
const TreeRowSettledContext = createContext<() => void>(() => {});
export const TREE_ITEM_TWEEN_DURATION_MS = 240;
const treeItemTween = {
  type: 'tween' as const,
  duration: TREE_ITEM_TWEEN_DURATION_MS / 1000,
  ease: [0.42, 0, 0.58, 1] as const,
};
const treeItemEnterOpacityTween = {
  type: 'tween' as const,
  duration: 0.16,
  ease: [0, 0, 0.58, 1] as const,
};
const treeItemExitOpacityTween = {
  type: 'tween' as const,
  duration: 0.16,
  delay: 0.08,
  ease: [0.42, 0, 1, 1] as const,
};
const treeItemVariants: Variants = {
  dragging: {
    height: 0,
    marginBottom: 0,
    opacity: 1,
    overflow: 'visible',
    transition: { duration: 0 },
  },
  collapsed: (animate: boolean) => animate
    ? {
        height: 0,
        marginBottom: 0,
        opacity: 0,
        overflow: 'hidden',
        transition: {
          height: treeItemTween,
          marginBottom: treeItemTween,
          opacity: treeItemExitOpacityTween,
        },
      }
    : {
        height: 0,
        marginBottom: 0,
        opacity: 0,
        overflow: 'hidden',
        transition: { duration: 0 },
      },
  open: (animate: boolean) => ({
    height: 'auto',
    marginBottom: 1,
    opacity: 1,
    transition: animate
      ? {
          height: treeItemTween,
          marginBottom: treeItemTween,
          opacity: treeItemEnterOpacityTween,
        }
      : { duration: 0 },
    transitionEnd: { overflow: 'visible' },
  }),
};

export function TreeMotionItem({
  children,
  dragging = false,
  exitDisabled = false,
  lifted = false,
  ...props
}: HTMLMotionProps<'li'> & {
  dragging?: boolean;
  exitDisabled?: boolean;
  /** A drag carries the row with the one it grabbed, so it closes. */
  lifted?: boolean;
}) {
  const animationEnabled = useContext(TreeMotionContext);
  const rowSettled = useContext(TreeRowSettledContext);
  const reduceMotion = useReducedMotion();
  const isPresent = useIsPresent();
  return (
    <motion.li
      // A carried row closes in motion even mid-drag, when the rest of the tree holds still.
      custom={lifted ? !reduceMotion : animationEnabled}
      variants={treeItemVariants}
      initial="collapsed"
      animate={dragging ? 'dragging' : lifted ? 'collapsed' : 'open'}
      exit={exitDisabled ? undefined : 'collapsed'}
      onAnimationComplete={rowSettled}
      {...props}
    >
      {exitDisabled && !isPresent ? null : children}
    </motion.li>
  );
}

/**
 * Drop targets are measured as a drag starts, so a row that opens or closes
 * mid-drag, such as one the drag carries, has them measured again once it has
 * settled, however late its frames run. Outside a drag this does nothing.
 */
function DropTargetMeasure({ measure }: { measure: RefObject<() => void> }) {
  const { measureDroppableContainers } = useDndContext();
  useEffect(() => {
    measure.current = () => measureDroppableContainers([]);
  }, [measure, measureDroppableContainers]);
  return null;
}

export function TreeDropPlaceholder({
  depth,
  invalid,
  position,
}: {
  depth: number;
  invalid: boolean;
  position: 'before' | 'after';
}) {
  return (
    <span
      className={`tree-drop-placeholder is-${position}${invalid ? ' is-invalid' : ''}`}
      style={{ '--drop-depth': depth } as CSSProperties}
      aria-hidden="true"
    />
  );
}

export function SortableTree({
  after,
  children,
  disabled,
  empty,
  itemIds,
  listClassName = 'tree-list',
  motionDisabled,
  rootId,
  rootIndex,
  zoneClassName = 'tree-drop-zone',
  zoneKind = 'tree-zone',
}: {
  /** Scrolls with the tree, below its root drop target. */
  after?: ReactNode;
  children: ReactNode;
  disabled?: boolean;
  empty?: ReactNode;
  itemIds: string[];
  listClassName?: string;
  motionDisabled?: boolean;
  rootId: string;
  rootIndex: number;
  zoneClassName?: string;
  zoneKind?: 'tree-zone' | 'tabs-zone';
}) {
  const reduceMotion = useReducedMotion();
  const animationEnabled = !motionDisabled && !reduceMotion;
  const measureDropTargets = useRef(() => {});
  const rowSettled = useCallback(() => measureDropTargets.current(), []);
  const dropZone = useDroppable({
    id: `${zoneKind}:${rootId}`,
    disabled,
    data: { kind: zoneKind, parentId: rootId },
  });
  const rootDropTarget = useDroppable({
    id: `${zoneKind}-root-target:${rootId}`,
    disabled,
    data: { kind: zoneKind, parentId: rootId, index: rootIndex },
  });

  return (
    <div
      ref={dropZone.setNodeRef}
      className={`${zoneClassName}${dropZone.isOver ? ' is-over' : ''}`}
    >
      {itemIds.length > 0 ? (
        <SortableContext items={itemIds} strategy={staticTreeSortingStrategy}>
          <ul className={listClassName}>
            <TreeMotionContext.Provider value={animationEnabled}>
              <TreeRowSettledContext.Provider value={rowSettled}>
                <AnimatePresence initial={false} custom={animationEnabled}>
                  {children}
                </AnimatePresence>
              </TreeRowSettledContext.Provider>
            </TreeMotionContext.Provider>
          </ul>
        </SortableContext>
      ) : empty}
      <div
        ref={rootDropTarget.setNodeRef}
        className="tree-root-drop-target"
        aria-hidden="true"
      />
      <DropTargetMeasure measure={measureDropTargets} />
      {after}
    </div>
  );
}