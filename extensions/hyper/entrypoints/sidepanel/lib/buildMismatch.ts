import { HYPER_BUILD_ID } from '../../lib/modelProtocol';

/**
 * Whether this page has met a background worker from another build. Every
 * model client on the page reports here, so the page shows one notice however
 * many clients it runs, and the notice survives the app failing to render.
 */
let mismatched = false;
const listeners = new Set<() => void>();

export function reportBuildMismatch(workerBuildId: string | undefined): void {
  if (mismatched) return;
  mismatched = true;
  console.warn(
    `Hyper's background is from build ${workerBuildId ?? '(none stated)'}, ` +
    `but this page is from build ${HYPER_BUILD_ID}. Reload Hyper to run one build.`,
  );
  for (const listener of [...listeners]) listener();
}

export function hasBuildMismatch(): boolean {
  return mismatched;
}

export function subscribeBuildMismatch(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
