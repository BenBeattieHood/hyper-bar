import { ArrowLeft } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { BookmarkFolderOption, Space } from '../../lib/bookmarks';
import type { SettingsPreferences } from '../hooks/useSettingsPreferences';
import type { TimedMessage } from '../../lib/timedMessages';
import { TimedMessageNotice } from './TimedMessageNotice';
import type { BookmarkImportDestination } from './BookmarkImportPrompt';
import { SettingsView } from './SettingsView';
import {
  settingsBackdropTransition,
  settingsSlideVariants,
  fadeMotion,
  slideMotion,
} from './WorkspaceMotion';

export function SettingsLayer({
  bookmarkActionsDisabled,
  globalBookmarksRootId,
  importBookmarkFolder,
  importFolders,
  reduceMotion,
  setSettingsOpen,
  settingsOpen,
  spaces,
  timedMessages,
  ...preferences
}: SettingsPreferences & {
  bookmarkActionsDisabled: boolean;
  globalBookmarksRootId?: string;
  importBookmarkFolder(sourceFolderId: string, destinationRootId: string): Promise<void>;
  importFolders: BookmarkFolderOption[];
  reduceMotion: boolean | null;
  setSettingsOpen(open: boolean): void;
  settingsOpen: boolean;
  spaces: Space[];
  timedMessages: {
    actOnTimedMessage(messageId: string): unknown;
    dismissTimedMessage(messageId: string): unknown;
    timedMessage?: TimedMessage;
  };
}) {
  const importDestinations: BookmarkImportDestination[] = [
    ...spaces.flatMap((space) => space.rootId
      ? [{ rootId: space.rootId, label: space.title }]
      : []),
    ...(globalBookmarksRootId
      ? [{ rootId: globalBookmarksRootId, label: 'Global bookmarks' }]
      : []),
  ];

  return (
    <AnimatePresence initial={false}>
      {settingsOpen && (
        <motion.div
          key="settings-backdrop"
          className="settings-backdrop"
          {...fadeMotion(reduceMotion, settingsBackdropTransition, 0.78)}
          aria-hidden="true"
        />
      )}
      {settingsOpen && (
        <motion.div
          key="settings"
          className="settings-layer"
          variants={settingsSlideVariants}
          animate="center"
          {...slideMotion(reduceMotion)}
        >
          <header className="topbar is-settings">
            <div className="settings-topbar">
              <button
                type="button"
                className="icon-button"
                onClick={() => setSettingsOpen(false)}
                aria-label="Back"
                title="Back"
              >
                <ArrowLeft size={18} aria-hidden="true" />
              </button>
              <h1 id="settings-title">Settings</h1>
            </div>
            <div className="topbar-actions">
              <TimedMessageNotice
                message={timedMessages.timedMessage}
                onAct={(messageId) => void timedMessages.actOnTimedMessage(messageId)}
                onDismiss={(messageId) => void timedMessages.dismissTimedMessage(messageId)}
              />
            </div>
          </header>
          <SettingsView
            {...preferences}
            importFolders={importFolders}
            importDestinations={importDestinations}
            bookmarkActionsDisabled={bookmarkActionsDisabled}
            onImportFolder={(folderId, destinationRootId) =>
              void importBookmarkFolder(folderId, destinationRootId)}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
