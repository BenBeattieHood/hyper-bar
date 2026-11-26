import type { Locator, Page } from '@playwright/test';

type Box = NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>;

/** Moves the pointer in 8 steps to the centre of a target, failing with `message` if it has no box. */
export async function movePointerToCenter(
  page: Page,
  target: Locator,
  message: string,
): Promise<Box> {
  const box = await target.boundingBox();
  if (!box) throw new Error(message);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  return box;
}
