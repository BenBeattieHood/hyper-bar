import type { CSSProperties } from 'react';
import type { TabGroupColour } from '../../lib/tabGroups';

/**
 * The theme colour a tab group colour names, as styles use it. A space with no
 * open group has no colour and is drawn in the muted tone its icons use.
 */
export const groupColourValue = (colour: TabGroupColour | undefined) =>
  colour ? `var(--tab-group-${colour})` : 'var(--muted)';

export const spaceColourValue = (space: { colour?: TabGroupColour }) => groupColourValue(space.colour);

/** Sets the custom property a stylesheet reads a group colour from. */
export const groupColourStyle = (property: `--${string}`, colour: TabGroupColour | undefined) =>
  ({ [property]: groupColourValue(colour) }) as CSSProperties;
