import {
  autoUpdate,
  FloatingFocusManager,
  FloatingPortal,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import {
  BookmarkPlus,
  FolderClosed,
  FolderPlus,
  History,
  Import,
  MonitorSmartphone,
  type LucideIcon,
} from 'lucide-react';
import { Fragment, useRef, useState, type ReactNode } from 'react';
import type { BookmarkFolderOption, BrowserTab } from '../../lib/bookmarks';
import type { RecentlyClosedTab } from '../../lib/recentlyClosed';
import { shortcutButtonProps, type ShortcutId } from '../../lib/shortcuts';
import { tabDisplayTitle, tabDisplayUrl } from '../../lib/tabs';
import { fittedMenuMiddleware } from './ContextMenu';
import { Favicon } from '@hyper/ui';

const MENU_ITEM_SELECTOR = '[role="menuitem"], [role="menuitemcheckbox"]';

interface BookmarkMenuItem {
  /** Makes the item a switch, on when true. */
  checked?: boolean;
  id: string;
  label: string;
  detail?: string;
  icon?: LucideIcon;
  sectionLabel?: string;
  visual?: ReactNode;
  onSelect: () => void;
}

interface BookmarkMenuProps {
  ariaLabel: string;
  disabled?: boolean;
  items: BookmarkMenuItem[];
  placement?: 'bottom-start' | 'bottom-end';
  triggerAriaLabel: string;
  triggerClassName: string;
  triggerContent: ReactNode;
  triggerTitle: string;
  /** The key that opens the menu, shown in its tooltip. */
  triggerShortcut?: ShortcutId;
}

function BookmarkMenu({
  ariaLabel,
  disabled,
  items,
  placement = 'bottom-end',
  triggerAriaLabel,
  triggerClassName,
  triggerContent,
  triggerShortcut,
  triggerTitle,
}: BookmarkMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { context, floatingStyles, refs } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    strategy: 'fixed',
    middleware: fittedMenuMiddleware(4, 4, true),
    whileElementsMounted: autoUpdate,
  });
  const click = useClick(context, { enabled: !disabled });
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'menu' });
  const { getFloatingProps, getReferenceProps } = useInteractions([
    click,
    dismiss,
    role,
  ]);

  const run = (item: BookmarkMenuItem) => {
    setOpen(false);
    triggerRef.current?.focus();
    item.onSelect();
  };

  return (
    <>
      <button
        ref={(node) => {
          triggerRef.current = node;
          refs.setReference(node);
        }}
        type="button"
        className={triggerClassName}
        disabled={disabled}
        {...getReferenceProps({
          'aria-label': triggerAriaLabel,
          'aria-expanded': open,
          'aria-haspopup': 'menu',
          ...(triggerShortcut ? shortcutButtonProps(triggerShortcut, triggerTitle) : { title: triggerTitle }),
          onPointerDown(event) {
            event.stopPropagation();
          },
          onClick(event) {
            event.stopPropagation();
          },
          onKeyDown(event) {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setOpen(true);
            } else if (event.key === 'Escape' && open) {
              event.preventDefault();
              setOpen(false);
            }
          },
        })}
      >
        {triggerContent}
      </button>
      {open && (
        <FloatingPortal root={document.querySelector<HTMLElement>('.app-shell')}>
          <FloatingFocusManager context={context} initialFocus={0} modal={false}>
            <div
              ref={refs.setFloating}
              className="bookmark-menu-popover bookmark-picker-popover"
              style={floatingStyles}
              {...getFloatingProps({
                'aria-label': ariaLabel,
                onPointerDown(event) {
                  event.stopPropagation();
                },
                onPointerMove(event) {
                  const item = (event.target as Element).closest<HTMLButtonElement>(
                    MENU_ITEM_SELECTOR,
                  );
                  item?.focus({ preventScroll: true });
                },
                onKeyDown(event) {
                  const menuItems = Array.from(
                    event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      MENU_ITEM_SELECTOR,
                    ),
                  );
                  const currentIndex = menuItems.indexOf(
                    document.activeElement as HTMLButtonElement,
                  );
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setOpen(false);
                    triggerRef.current?.focus();
                  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    const direction = event.key === 'ArrowDown' ? 1 : -1;
                    const nextIndex = (
                      currentIndex + direction + menuItems.length
                    ) % menuItems.length;
                    menuItems[nextIndex]?.focus();
                  } else if (event.key === 'Home' || event.key === 'End') {
                    event.preventDefault();
                    menuItems[event.key === 'Home' ? 0 : menuItems.length - 1]?.focus();
                  }
                },
              })}
            >
              {items.map((item) => {
                const Icon = item.icon;
                return (
                  <Fragment key={item.id}>
                    {item.sectionLabel && (
                      <div
                        className="bookmark-menu-separator"
                        role="separator"
                        aria-label={item.sectionLabel}
                      >
                        {item.sectionLabel}
                      </div>
                    )}
                    <button
                      type="button"
                      role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                      aria-checked={item.checked}
                      data-menu-item-id={item.id}
                      title={item.detail ?? item.label}
                      onClick={() => run(item)}
                    >
                      {item.visual ?? (Icon ? <Icon size={14} aria-hidden="true" /> : null)}
                      <span className="bookmark-menu-item-copy">
                        <strong>{item.label}</strong>
                        {item.detail && <small>{item.detail}</small>}
                      </span>
                      {item.checked !== undefined && (
                        <span className="settings-switch" aria-hidden="true"><span /></span>
                      )}
                    </button>
                  </Fragment>
                );
              })}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}

export interface CreateAction {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  shortcut?: ShortcutId;
}

export function CreateActionGroup({
  actions,
  buttonClassName,
  disabled,
  groupLabel,
  trailingAction,
}: {
  actions: readonly CreateAction[];
  buttonClassName: string;
  disabled?: boolean;
  groupLabel: string;
  trailingAction?: ReactNode;
}) {
  return (
    <span className="create-action-group" role="group" aria-label={groupLabel}>
      {actions.map(({ icon: Icon, label, onClick, shortcut }) => (
        <button
          key={label}
          type="button"
          className={buttonClassName}
          disabled={disabled}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onClick();
          }}
          aria-label={label}
          {...(shortcut ? shortcutButtonProps(shortcut, label) : { title: label })}
        >
          <Icon size={14} aria-hidden="true" />
        </button>
      ))}
      {trailingAction}
    </span>
  );
}

export function BookmarkCreateActions({
  bookmarkLabel = 'Bookmark current tab',
  folderLabel = 'Create folder',
  folderFirst = false,
  folderShortcut,
  onAddCurrentTab,
  onCreateFolder,
  showFolder = true,
  ...group
}: {
  bookmarkLabel?: string;
  buttonClassName: string;
  disabled?: boolean;
  folderLabel?: string;
  folderFirst?: boolean;
  /** Header buttons show the keys that do the same. */
  folderShortcut?: ShortcutId;
  groupLabel: string;
  onAddCurrentTab?: () => void;
  onCreateFolder: () => void;
  showFolder?: boolean;
  trailingAction?: ReactNode;
}) {
  const actions: CreateAction[] = [
    ...(onAddCurrentTab ? [{ icon: BookmarkPlus, label: bookmarkLabel, onClick: onAddCurrentTab }] : []),
    ...(showFolder ? [{ icon: FolderPlus, label: folderLabel, onClick: onCreateFolder, shortcut: folderShortcut }] : []),
  ];
  return <CreateActionGroup actions={folderFirst ? actions.reverse() : actions} {...group} />;
}

export interface RecentTabsMenuContent {
  closedTabs: readonly RecentlyClosedTab[];
  onRestore: (sessionId: string) => void;
  onSelect: (tab: BrowserTab) => void;
  onToggleOtherSessions: () => void;
  showOtherSessions: boolean;
  tabs: BrowserTab[];
}

export function RecentTabsMenu({
  buttonClassName,
  closedTabs,
  onRestore,
  onSelect,
  onToggleOtherSessions,
  showOtherSessions,
  tabs,
}: RecentTabsMenuContent & { buttonClassName: string }) {
  return (
    <BookmarkMenu
      ariaLabel="Recent tabs"
      items={[
        {
          checked: showOtherSessions,
          icon: MonitorSmartphone,
          id: 'other-sessions',
          label: 'Show tabs from other sessions',
          onSelect: onToggleOtherSessions,
        },
        ...tabs.flatMap((tab, index) => tab.id === undefined ? [] : [{
          id: String(tab.id),
          label: tabDisplayTitle(tab),
          ...(index === 0 ? { sectionLabel: 'Recent tabs' } : {}),
          visual: (
            <Favicon
              loading={tab.status === 'loading'}
              sourceUrl={tab.favIconUrl}
              title={tabDisplayTitle(tab)}
              url={tabDisplayUrl(tab)}
            />
          ),
          onSelect: () => onSelect(tab),
        }]),
        ...closedTabs.map((tab, index) => ({
          id: `closed:${tab.sessionId}`,
          label: tab.title,
          ...(index === 0 ? { sectionLabel: 'Recently closed' } : {}),
          visual: <Favicon sourceUrl={tab.favIconUrl} title={tab.title} url={tab.url} />,
          onSelect: () => onRestore(tab.sessionId),
        })),
      ]}
      triggerAriaLabel="Show recent tabs"
      triggerClassName={buttonClassName}
      triggerContent={<History size={14} aria-hidden="true" />}
      triggerShortcut="recentTabs"
      triggerTitle="Recent tabs"
    />
  );
}

export function BookmarkImportMenu({
  disabled,
  folders,
  onImport,
  variant,
}: {
  disabled?: boolean;
  folders: BookmarkFolderOption[];
  onImport: (folderId: string) => void;
  variant: 'empty' | 'settings';
}) {
  const settings = variant === 'settings';
  return (
    <BookmarkMenu
      ariaLabel="Choose a browser bookmark folder to import"
      disabled={disabled || folders.length === 0}
      placement={settings ? 'bottom-start' : 'bottom-end'}
      triggerAriaLabel="Import bookmarks from another browser folder"
      triggerClassName={settings ? 'settings-toggle-row' : 'empty-tree-action'}
      triggerTitle={folders.length > 0
        ? 'Import bookmarks from another browser folder'
        : 'No other browser bookmark folders are available'}
      triggerContent={settings ? (
        <>
          <span className="settings-row-icon"><Import size={17} aria-hidden="true" /></span>
          <span>
            <strong>Import bookmarks</strong>
            <small>Copy another browser bookmark folder into Hyper</small>
          </span>
          <span className="settings-access-remove" aria-hidden="true">Choose</span>
        </>
      ) : (
        <>
          <Import size={15} aria-hidden="true" />
          <span className="empty-tree-action-label">Import bookmarks</span>
        </>
      )}
      items={folders.map((folder) => ({
        id: folder.id,
        label: folder.title,
        detail: folder.path === folder.title ? undefined : folder.path,
        icon: FolderClosed,
        onSelect: () => onImport(folder.id),
      }))}
    />
  );
}
