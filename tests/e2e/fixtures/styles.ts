import type { Locator } from '@playwright/test';

/**
 * Resolves a custom property to the colour it actually paints.
 *
 * `getPropertyValue` returns the declaration verbatim — a `color-mix(...)`
 * expression rather than a colour — so the only way to compare it against a
 * computed background is to let the browser paint it first.
 */
export async function paintedCustomProperty(
  scope: Locator,
  property: string,
): Promise<string> {
  return scope.evaluate((element, name) => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = getComputedStyle(element).getPropertyValue(name);
    element.append(probe);
    const painted = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return painted;
  }, property);
}
