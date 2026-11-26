import {
  AnimatePresence,
  motion,
  useIsPresent,
  usePresenceData,
  useReducedMotion,
  type MotionProps,
  type Variants,
} from 'motion/react';
import type { ReactNode } from 'react';
import { TabActivationVisibilityContext } from './Tabs';
import type { TabGroupColour } from '../../lib/tabGroups';
import { groupColourValue } from '../lib/groupColour';

export type SlideDirection = -1 | 1;
export type WorkspaceTransitionKind = 'space' | 'view';
export type WorkspaceSlideIntent = {
  direction: SlideDirection;
  kind: WorkspaceTransitionKind;
};

export const spaceSlideVariants: Variants = {
  enter: (direction: SlideDirection) => ({ x: `${direction * 100}%` }),
  center: { x: 0 },
  exit: (direction: SlideDirection) => ({ x: `${direction * -100}%` }),
};
const spaceSlideTransition = {
  type: 'tween' as const,
  duration: 0.28,
  ease: [0.2, 0.75, 0.25, 1] as const,
};
/** How a presence child enters and leaves; under reduced motion it appears and goes at once. */
export function presenceMotion(
  reduceMotion: boolean | null,
  initial: MotionProps['initial'],
  exit: MotionProps['exit'],
  transition: MotionProps['transition'],
): Pick<MotionProps, 'exit' | 'initial' | 'transition'> {
  return reduceMotion ? { initial: false, transition: { duration: 0 } } : { initial, exit, transition };
}
/** Fades in to `opacity` and back out as it leaves. */
export const fadeMotion = (reduceMotion: boolean | null, transition: MotionProps['transition'], opacity = 1) => ({
  animate: { opacity },
  ...presenceMotion(reduceMotion, { opacity: 0 }, { opacity: 0 }, transition),
});
/** A favourites popover drops into place as it shows; under reduced motion it only fades. */
export function popoverMotion(
  reduceMotion: boolean | null,
  showFor: number,
  hideFor: number,
): Pick<MotionProps, 'animate' | 'exit' | 'initial'> {
  const y = reduceMotion ? 0 : -4;
  const ease = [0.2, 0, 0, 1] as const;
  return {
    initial: { opacity: 0, y },
    animate: { opacity: 1, y: 0, transition: { duration: showFor, ease } },
    exit: { opacity: 0, y, pointerEvents: 'none', transition: { duration: hideFor, ease } },
  };
}
/** Enter and exit for the sliding layers of the workspace. */
export const slideMotion = (reduceMotion: boolean | null) => presenceMotion(reduceMotion, 'enter', 'exit', spaceSlideTransition);
export const settingsSlideVariants: Variants = {
  enter: { x: '100%' },
  center: { x: 0 },
  exit: { x: '100%' },
};
export const settingsBackdropTransition = {
  duration: 0.22,
  ease: 'easeOut' as const,
};
export const workspaceSlideVariants: Variants = {
  enter: ({ direction, kind }: WorkspaceSlideIntent) => kind === 'space'
    ? { x: `${direction * 100}%`, opacity: 1 }
    : { x: direction * 28, opacity: 0.58 },
  center: { x: 0, opacity: 1 },
  exit: ({ direction, kind }: WorkspaceSlideIntent) => kind === 'space'
    ? { x: `${direction * -100}%`, opacity: 1 }
    : { x: direction * 28, opacity: 0 },
};

export function ViewTransitionItems({
  children,
  enabled,
  view,
}: {
  children: ReactNode;
  enabled: boolean;
  view: 'tabs' | 'bookmarks';
}) {
  const isPresent = useIsPresent();
  const intent = usePresenceData() as WorkspaceSlideIntent | undefined;
  const staggered = enabled && intent?.kind === 'view';
  return (
    <TabActivationVisibilityContext.Provider value={view !== 'tabs' || isPresent}>
      <div
        className={`view-transition-items${staggered ? ` is-${isPresent ? 'entering' : 'exiting'} is-${view}` : ''}`}
      >
        {children}
      </div>
    </TabActivationVisibilityContext.Provider>
  );
}

export function SpaceColourStrip({
  colour,
  direction,
  spaceId,
}: {
  colour: TabGroupColour | undefined;
  direction: SlideDirection;
  spaceId: string;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <div className="space-colour-track" aria-hidden="true">
      <AnimatePresence initial={false} custom={direction}>
        <motion.div
          key={spaceId}
          className="space-colour-strip"
          custom={direction}
          variants={spaceSlideVariants}
          animate="center"
          {...slideMotion(reduceMotion)}
          style={{ background: groupColourValue(colour) }}
          data-space-id={spaceId}
        />
      </AnimatePresence>
    </div>
  );
}
