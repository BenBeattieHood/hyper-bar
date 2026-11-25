import { ACTIVE_SPACE_WINDOW_VALUE_KEY } from '../../../entrypoints/lib/windowState';
import type { ExtensionGlobal } from '../helpers/extensionGlobal';

/**
 * Consecutive unchanged samples before activation counts as settled.
 *
 * The floor this implies is deliberate. New-tab attribution is fenced by state
 * the background keeps in memory, which no amount of sampling can observe, so
 * the window can look still while a tab opened now would still be attributed to
 * the space being left.
 */
const QUIESCENT_SAMPLES = 10;
const SAMPLE_INTERVAL_MS = 100;
/** Bounded so a busy browser costs about what the fixed sleep used to. */
const QUIESCENCE_BUDGET_MS = 4_000;
/** Every session key the extension writes while a space is being activated. */
const EXTENSION_SESSION_PREFIX = 'hyper';

/** Anything with extension privileges can sample: the worker or an extension page. */
interface ExtensionContext {
  evaluate<Result, Argument>(
    fn: (argument: Argument) => Promise<Result>,
    argument: Argument,
  ): Promise<Result>;
}

/**
 * A signature of everything space activation moves: tab order, grouping, focus,
 * group collapse, and the session state that decides which space owns a tab.
 *
 * The session state matters as much as the tabs. A window can stop moving while
 * the extension is still deciding which space is active, and a tab opened in
 * that gap is attributed to the space being left.
 */
async function activationFingerprint(
  context: ExtensionContext,
  sessionPrefix: string,
): Promise<string> {
  return context.evaluate(async (prefix) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const tabs = (await extension.chrome.tabs.query({ currentWindow: true }))
      .sort((left, right) => left.index - right.index);
    const groupIds = new Set(tabs.flatMap((tab) =>
      tab.groupId === undefined || tab.groupId < 0 ? [] : [tab.groupId]));
    const groups = (await extension.chrome.tabGroups?.query({}).catch(() => []) ?? [])
      .filter((group) => groupIds.has(group.id))
      .sort((left, right) => left.id - right.id);
    const session = await extension.chrome.storage.session?.get(null)
      .catch(() => ({} as Record<string, unknown>)) ?? {};
    const activeSpaceId = tabs[0]?.windowId === undefined
      ? undefined
      : await extension.chrome.sessions?.getWindowValue?.(
          tabs[0].windowId,
          ACTIVE_SPACE_WINDOW_VALUE_KEY,
        ).catch(() => undefined);
    return [
      tabs.map((tab) =>
        `${tab.id}:${tab.index}:${tab.groupId ?? -1}:${tab.active ? 1 : 0}`).join(','),
      groups.map((group) => `${group.id}:${group.collapsed ? 1 : 0}`).join(','),
      Object.keys(session).filter((key) => key.startsWith(prefix)).sort()
        .map((key) => `${key}=${JSON.stringify(session[key])}`).join(','),
      JSON.stringify(activeSpaceId),
    ].join('|');
  }, sessionPrefix);
}

/**
 * Waits for space activation to stop moving rather than guessing how long it
 * takes.
 *
 * Activation keeps mutating tabs in the background after the sidebar marks a
 * space current, so a fixed sleep is wrong in both directions: it wastes time
 * when activation is quick and races the tail of the work when the machine is
 * loaded. Sampling until the window stops changing is fast when the browser is
 * idle and patient when it is not.
 *
 * This is a synchronisation aid, not an assertion, so exhausting the budget is
 * not a failure. A caller that needs a specific outcome still asserts it, and
 * gets a message about that outcome instead of one about sampling.
 */
export async function waitForActivationQuiescence(
  context: ExtensionContext,
  budgetMs = QUIESCENCE_BUDGET_MS,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let previous: string | undefined;
  let unchanged = 0;
  while (unchanged < QUIESCENT_SAMPLES && Date.now() < deadline) {
    const current = await activationFingerprint(context, EXTENSION_SESSION_PREFIX);
    unchanged = current === previous ? unchanged + 1 : 0;
    previous = current;
    if (unchanged < QUIESCENT_SAMPLES) {
      await new Promise((resolve) => setTimeout(resolve, SAMPLE_INTERVAL_MS));
    }
  }
}
