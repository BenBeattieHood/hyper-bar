import { useState, useSyncExternalStore } from 'react';
import { hasBuildMismatch, subscribeBuildMismatch } from '../lib/buildMismatch';
import './BuildMismatchNotice.css';

interface BuildMismatchNoticeProps {
  /** Lets a frame ask the web page around it to take it down, since that page outlives the reload. */
  onBeforeReload?: () => void;
  placement: 'page' | 'sidebar';
  /** For a frame its web page keeps: once Hyper reloads, says what brings Hyper back to that page. */
  reloadedMessage?: string;
}

/**
 * Stays until Hyper is reloaded. The browser keeps starting the background
 * worker script it registered, while this page loaded a newer build from disk,
 * so a change the worker does not understand would otherwise silently do nothing.
 *
 * It renders beside the app's error boundary rather than inside it, because a
 * projection from another build is also what is most likely to break the app,
 * and the boundary's own Reload reloads only the page, not the worker.
 */
export function BuildMismatchNotice({ onBeforeReload, placement, reloadedMessage }: BuildMismatchNoticeProps) {
  const mismatched = useSyncExternalStore(subscribeBuildMismatch, hasBuildMismatch);
  const [reloaded, setReloaded] = useState(false);
  if (!mismatched) return null;
  const reload = () => {
    onBeforeReload?.();
    setReloaded(true);
    browser.runtime.reload();
  };
  return (
    <div className={`build-mismatch-notice is-${placement}${reloaded ? ' is-reloaded' : ''}`} role="alert">
      <span className="build-mismatch-notice__message">
        {reloaded && reloadedMessage ? reloadedMessage : 'Hyper was updated.'}
      </span>
      {!reloaded && (
        <button className="build-mismatch-notice__action" onClick={reload} type="button">
          Reload Hyper
        </button>
      )}
    </div>
  );
}
