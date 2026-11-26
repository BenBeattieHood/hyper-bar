import { pickCyclic } from '../../lib/collections';

export const INSPIRATION_LINES = [
  'A clear next step is more useful than a perfect distant dream',
  'Begin with the smallest version that can teach you something',
  'Focus is deciding what can wait',
  'Good work often starts as a rough first draft',
  'Leave a little space for the unexpected idea',
  'Momentum is built of small consistent steps',
  'One thoughtful pause can rescue a scattered day',
  'Progress becomes easier when you can track it',
  'Protect the quiet needed to think clearly',
  'Small improvements compound into calmer systems',
  'Start where the uncertainty is highest',
  'There is often a shorter path to the same goal',
  'Trade a little polish for a little more learning',
  'Write down problems before starting to solve them',
  'Your attention is a tool; put it where it matters',
  'A useful constraint can guardrail and accelerate progress',
  'Use a different space for tabs that belong to another task',
  'Create a space for each context you return to often',
  'End a session by leaving yourself one clear next step',
  'Group related tabs into folders and spaces before they become background noise',
  'If a page matters, bookmark it where you will look for it',
  'Keep reference tabs separate from tasks that need action',
  'Name spaces after outcomes, not vague categories',
  'Pin only what deserves to remain visible every day',
  'Turn recurring research into a tidy bookmark folder',
  'When stuck, reduce the requirements',
  'A calm workspace makes room for ambitious thinking',
  'Make room for depth by saying no to the trivial',
  'Save the insight, not every step that led to it',
  'When too many tasks feels important, restate the goal',
  'Work in a way that makes restarting easy',
  'Keep what supports your goal and trim what merely surrounds it',
  'Today is easier when yesterday left a good trail',
] as const;

export function randomInspiration(random: () => number = Math.random): string {
  return pickCyclic(INSPIRATION_LINES, Math.floor(random() * INSPIRATION_LINES.length));
}