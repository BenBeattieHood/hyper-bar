import { AppWindow, Component, FileSearch, Folders, Logs, MessageSquareLock, PanelLeft, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { BookmarkImportMenu } from './BookmarkMenu';
import { BookmarkImportPrompt, type BookmarkImportDestination } from './BookmarkImportPrompt';
import { SettingsSlider } from './SettingsSlider';
import type { BookmarkFolderOption } from '../../lib/bookmarks';
import type { PreferenceSetting } from '../hooks/usePreferenceSetting';
import type { SettingsPreferences } from '../hooks/useSettingsPreferences';

interface SettingsViewProps extends SettingsPreferences {
  importFolders: BookmarkFolderOption[];
  importDestinations: BookmarkImportDestination[];
  bookmarkActionsDisabled: boolean;
  onImportFolder: (folderId: string, destinationRootId: string) => void;
}

function SettingsSection({ children, id, title }: { children: ReactNode; id: string; title: string }) {
  return (
    <section className="settings-section" aria-labelledby={`${id}-settings-title`}>
      <div className="settings-section-heading">
        <h2 id={`${id}-settings-title`}>{title}</h2>
      </div>
      {children}
    </section>
  );
}

/** A switch showing a preference, off limits while a change to it is under way. */
function SettingsSwitch({
  detail,
  icon: Icon,
  setting,
  title,
}: {
  detail: string;
  icon: LucideIcon;
  setting: PreferenceSetting;
  title: string;
}) {
  return (
    <button
      type="button"
      className="settings-toggle-row"
      role="switch"
      aria-checked={setting.enabled}
      disabled={setting.isPending}
      onClick={() => void setting.toggle()}
    >
      <span className="settings-row-icon"><Icon size={17} aria-hidden="true" /></span>
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <span className="settings-switch" aria-hidden="true"><span /></span>
    </button>
  );
}

export function SettingsView(props: SettingsViewProps) {
  const { bookmarkActionsDisabled, importFolders, timedMessageSetting } = props;
  const [importSourceId, setImportSourceId] = useState<string>();
  const importSource = importFolders.find((folder) => folder.id === importSourceId);

  return (
    <main className="settings-page workspace-scroll" aria-labelledby="settings-title">
      <SettingsSection id="search" title="Search">
        <SettingsSwitch
          detail="Find open tabs by the words on their pages"
          icon={FileSearch}
          setting={props.contentSearch}
          title="Include searching within page text"
        />
      </SettingsSection>

      <SettingsSection id="favourite" title="Favourites/Recent">
        <SettingsSwitch
          detail="One tile per site, listing its pages on hover"
          icon={Component}
          setting={props.favouriteGrouping}
          title="Group tiles by domain"
        />
      </SettingsSection>

      <SettingsSection id="tab" title="Tabs/Bookmarks">
        <div className="settings-control-list">
          <SettingsSwitch
            detail="Show open tabs below the bookmark tree"
            icon={Logs}
            setting={props.combineTabsAndBookmarks}
            title="Combine tabs and bookmarks"
          />
          <SettingsSwitch
            detail="Group top-level tabs by domain"
            icon={Folders}
            setting={props.tabFolders}
            title="Use Autofolders"
          />
          <SettingsSwitch
            detail="Reordering here or in the tab bar moves the other"
            icon={AppWindow}
            setting={props.tabStripOrder}
            title="Re-arrange browser tab bar"
          />
          <BookmarkImportMenu
            disabled={bookmarkActionsDisabled}
            folders={importFolders}
            onImport={setImportSourceId}
            variant="settings"
          />
        </div>
        {importSource && !bookmarkActionsDisabled && (
          <BookmarkImportPrompt
            destinations={props.importDestinations}
            folder={importSource}
            onClose={() => setImportSourceId(undefined)}
            onImport={(destinationRootId) => props.onImportFolder(importSource.id, destinationRootId)}
          />
        )}
      </SettingsSection>

      <SettingsSection id="system" title="System">
        <div className="settings-control-list">
          <SettingsSwitch
            detail="Open Hyper from the corner of any webpage"
            icon={PanelLeft}
            setting={props.inPageSidebarSetting}
            title="Show in pages"
          />
          <div className="settings-slider-row">
            <span className="settings-row-icon"><MessageSquareLock size={17} aria-hidden="true" /></span>
            <span>
              <strong><label htmlFor="timed-message-seconds">Message timing</label></strong>
              <small>How long messages and undo stay up</small>
            </span>
            <output className="settings-slider-value" htmlFor="timed-message-seconds">
              {timedMessageSetting.seconds}s
            </output>
            <SettingsSlider
              id="timed-message-seconds"
              inputProps={timedMessageSetting.inputProps}
              minLabel="Fast"
              maxLabel="Relaxed"
            />
          </div>
        </div>
      </SettingsSection>
    </main>
  );
}
