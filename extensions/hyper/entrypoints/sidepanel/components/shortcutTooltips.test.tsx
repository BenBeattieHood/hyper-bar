import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import type { ComponentProps, ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Space } from '../../lib/bookmarks';
import { SHORTCUT_IDS, SHORTCUTS, shortcutLabel, type ShortcutId } from '../../lib/shortcuts';
import { BookmarkCreateActions } from './BookmarkMenu';
import { GlobalBookmarksButton } from './FavouritesGrid';
import { SidebarTopbar } from './SidebarTopbar';
import { SpacePaginationNav } from './SpacePaginationNav';
import { WorkspaceViewToolbar } from './WorkspaceViewToolbar';

const noop = () => undefined;
const asyncNoop = async () => undefined;
const spaces: Space[] = Array.from({ length: 10 }, (_, index) => ({
  id: `space-${index}`,
  rootId: `root-${index}`,
  title: `Space ${index + 1}`,
} as Space));
const firstSpace = spaces[0] as Space;

const render = (element: ReactElement) => renderToStaticMarkup(
  <DndContext>
    <SortableContext items={[]}>{element}</SortableContext>
  </DndContext>,
);

const decode = (text: string) => text
  .replaceAll('&quot;', '"')
  .replaceAll('&#x27;', "'")
  .replaceAll('&lt;', '<')
  .replaceAll('&gt;', '>')
  .replaceAll('&amp;', '&');

/** Every rendered element that names a shortcut, with its tooltip. */
function shortcutControls(markup: string) {
  return Array.from(markup.matchAll(/<[a-z]+\s[^>]*>/g)).flatMap(([tag]) => {
    const id = /data-shortcut="([^"]*)"/.exec(tag)?.[1];
    if (!id) return [];
    const title = /title="([^"]*)"/.exec(tag)?.[1];
    return [{ id: id as ShortcutId, title: title === undefined ? undefined : decode(title) }];
  });
}

const toolbarProps = (wide: boolean): ComponentProps<typeof WorkspaceViewToolbar> => ({
  view: 'tabs',
  wide,
  sidebarSide: 'left',
  onSelectTabs: noop,
  onSelectBookmarks: noop,
  onDragHover: noop,
  onDragHoverEnd: noop,
  onCreateTabFolder: noop,
  onCreateBookmarkFolder: noop,
  bookmarkActionsDisabled: false,
  recentTabsMenu: {
    closedTabs: [],
    onRestore: noop,
    onSelect: noop,
    onToggleOtherSessions: noop,
    showOtherSessions: false,
    tabs: [],
  },
});

const stub = <T,>(value: object) => value as T;

function renderSidebarControls(): string {
  return [
    render(
      <SidebarTopbar
        activeSpace={firstSpace}
        browserState={stub({ tabs: [], timedMessage: undefined })}
        clearSelectedTabsAfter={(operation) => operation}
        commandActions={[]}
        itemMenu={() => []}
        nodeMap={new Map()}
        reduceMotion
        searchOpen={false}
        searchRef={{ current: null }}
        searchTriggerRef={{ current: null }}
        selectSpace={async () => true}
        setCollapsedIds={noop}
        setSearchOpen={noop}
        setSettingsOpen={noop}
        showGlobalBookmarks={noop}
        settingsOpen={false}
        showNotice={noop}
        spaceColours={{}}
      />,
    ),
    render(<WorkspaceViewToolbar {...toolbarProps(false)} />),
    render(<WorkspaceViewToolbar {...toolbarProps(true)} />),
    render(<GlobalBookmarksButton open={false} onToggle={noop} />),
    render(<GlobalBookmarksButton open onToggle={noop} />),
    render(
      <SpacePaginationNav
        activeDrag={undefined}
        activeDragTrashDisabled={false}
        activeDragTrashLabel={undefined}
        activeSpace={firstSpace}
        archivePanel={stub({ arming: false, open: false })}
        archivedSpaces={[]}
        armingSpaceId={undefined}
        browserState={stub({ isBackingOperationPending: false, spaceGroupColours: {} })}
        createSpace={asyncNoop}
        dragOverTarget={undefined}
        extensionOrigin="chrome-extension://hyper"
        focusAudibleTab={asyncNoop}
        mediaControls={stub({ displayTabs: [] })}
        mediaControlsDragDisabled={false}
        mediaReturnTab={undefined}
        noticeOnFailure={() => noop}
        openSpaceMenu={noop}
        reduceMotion
        selectSpace={async () => true}
        spaces={spaces}
        toggleAudibleTabMuted={asyncNoop}
        spaceInsertion={undefined}
      />,
    ),
  ].join('');
}

describe('shortcut tooltips', () => {
  const controls = shortcutControls(renderSidebarControls());

  it('names the key in the tooltip of every control that has one', () => {
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(SHORTCUTS[control.id], control.id).toBeDefined();
      expect(control.title, control.id).toContain(`(${shortcutLabel(control.id)})`);
    }
  });

  it('renders a control for every shortcut a button runs', () => {
    const rendered = new Set(controls.map((control) => control.id));
    const missing = SHORTCUT_IDS.filter((id) => SHORTCUTS[id].button && !rendered.has(id));

    expect(missing).toEqual([]);
  });

  it('gives only the first nine space buttons a key', () => {
    const markup = renderSidebarControls();

    expect(markup).toContain(`title="Space 9 (${shortcutLabel('space9')})"`);
    expect(markup).toContain('title="Space 10"');
  });

  it('leaves create buttons outside the list headers without a key', () => {
    const markup = render(
      <BookmarkCreateActions
        buttonClassName="tree-add"
        groupLabel="Create in folder"
        onAddCurrentTab={noop}
        onCreateFolder={noop}
      />,
    );

    expect(shortcutControls(markup)).toEqual([]);
    expect(markup).toContain('title="Bookmark current tab"');
  });
});
