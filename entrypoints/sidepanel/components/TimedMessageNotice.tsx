import { Check, Copy, Undo2, X, type LucideIcon } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion, type MotionProps } from 'motion/react';
import { useState, type CSSProperties } from 'react';
import type { TimedMessage, TimedMessageKind } from '../../lib/timedMessages';

/** Each kind of message has one button, and its icon says what pressing it does (build spec §27). */
const buttons: Record<TimedMessageKind, { icon: LucideIcon; label: string }> = {
  feedback: { icon: Copy, label: 'Copy this message' },
  'opt-in': { icon: Check, label: 'Yes, do it' },
  'opt-out': { icon: X, label: 'No, cancel it' },
  undo: { icon: Undo2, label: 'Undo' },
};

function fullText(message: TimedMessage): string {
  return message.detail ? `${message.text}\n${message.detail}` : message.text;
}

const noticeEase = [0.2, 0, 0, 1] as const;

/** Drops in from the top as it shows and rises back out as it goes; under reduced motion it only fades. */
function noticeMotion(reduceMotion: boolean | null): Pick<MotionProps, 'animate' | 'exit' | 'initial'> {
  const y = reduceMotion ? 0 : -12;
  return {
    initial: { opacity: 0, y },
    animate: { opacity: 1, y: 0, transition: { duration: 0.2, ease: noticeEase } },
    exit: { opacity: 0, y, pointerEvents: 'none', transition: { duration: 0.16, ease: noticeEase } },
  };
}

interface NoticeActions {
  onAct(messageId: string): void;
  /** Closes the message without pressing its button, as a middle click does. */
  onDismiss(messageId: string): void;
}

/**
 * The window's one timed message: its text, and a ring that empties while the
 * button stays able to change the best guess, undo, or copy the report.
 * A newer message waits for the older one to leave before it shows.
 */
export function TimedMessageNotice({ message, ...actions }: NoticeActions & { message?: TimedMessage }) {
  const reduceMotion = useReducedMotion();
  return (
    <AnimatePresence mode="wait">
      {message && (
        <motion.div
          key={message.id}
          className={`countdown-notice is-${message.tone}`}
          data-kind={message.kind}
          {...noticeMotion(reduceMotion)}
          onMouseDown={(event) => {
            // Keeps the browser's middle-click autoscroll from starting.
            if (event.button === 1) event.preventDefault();
          }}
          onAuxClick={(event) => {
            if (event.button !== 1) return;
            event.preventDefault();
            actions.onDismiss(message.id);
          }}
        >
          <Notice message={message} onAct={actions.onAct} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Notice({ message, onAct }: { message: TimedMessage; onAct(messageId: string): void }) {
  // Read once, so later renders do not move the ring the animation is already drawing.
  const [elapsedMs] = useState(() =>
    Math.max(0, message.durationMs - (message.expiresAt - Date.now())));
  const [copied, setCopied] = useState(false);
  const button = buttons[message.kind];
  const Icon = copied ? Check : button.icon;
  const press = () => {
    if (message.kind !== 'feedback') {
      onAct(message.id);
      return;
    }
    void navigator.clipboard?.writeText(fullText(message)).then(() => setCopied(true), () => undefined);
  };
  return (
    <>
      <span className="countdown-notice-message" role="status" title={fullText(message)}>
        {message.text}
      </span>
      <button
        type="button"
        className="icon-button countdown-button"
        onClick={press}
        aria-label={copied ? 'Copied' : button.label}
        title={copied ? 'Copied' : button.label}
        style={{
          '--countdown-duration': `${message.durationMs}ms`,
          '--countdown-elapsed': `-${elapsedMs}ms`,
        } as CSSProperties}
      >
        <svg className="countdown-button-progress" viewBox="0 0 24 24" aria-hidden="true">
          <circle className="countdown-button-track" cx="12" cy="12" r="10" />
          <circle className="countdown-button-ring" cx="12" cy="12" r="10" pathLength="100" />
        </svg>
        <Icon className="countdown-button-icon" size={12} strokeWidth={2.75} aria-hidden="true" />
      </button>
    </>
  );
}
