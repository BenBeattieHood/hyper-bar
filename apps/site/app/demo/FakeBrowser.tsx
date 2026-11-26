'use client';

import { ArrowLeft, ArrowRight, Bookmark, CornerDownLeft, Minus, Plus, RotateCw, Square, X } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { BrowserTab } from 'hyper-sidebar/demo';
import { useBrowserAppearance } from './browserAppearance';
import { useDemoBrowserSession } from './useDemoBrowserSession';

function titleFor(tab: BrowserTab | undefined) {
  return tab?.title?.trim() || tab?.url || 'New tab';
}

function PagePreview({ tab }: { tab: BrowserTab | undefined }) {
  const hostname = (() => {
    try { return new URL(tab?.url ?? 'https://hyper.local/start').hostname; }
    catch { return 'New tab'; }
  })();
  return (
    <section className="browser-page" aria-label={`Preview of ${titleFor(tab)}`}>
      <p className="browser-page-kicker">{hostname}</p>
      <h2>{titleFor(tab)}</h2>
      <p>
        This page is part of the live browser sandbox. Navigate, open another tab,
        bookmark this page, or switch spaces—the real Hyper sidebar updates beside it.
      </p>
      <div className="browser-page-cards" aria-hidden="true">
        <div className="browser-page-card"><strong>Recent work</strong><span /><span /><span /></div>
        <div className="browser-page-card"><strong>Open loops</strong><span /><span /><span /></div>
        <div className="browser-page-card"><strong>Reference</strong><span /><span /><span /></div>
        <div className="browser-page-card"><strong>Next up</strong><span /><span /><span /></div>
      </div>
    </section>
  );
}

export default function FakeBrowser() {
  const session = useDemoBrowserSession();
  const appearance = useBrowserAppearance();
  const [address, setAddress] = useState(session.address);
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => setAddress(session.address), [session.address]);

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    void session.controls.navigate(address, session.activeTab?.id);
  };

  const resizeSidebar = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const content = contentRef.current;
    if (!content) return;

    const bounds = content.getBoundingClientRect();
    const nextWidth = bounds.right - event.clientX;
    const minimum = 280;
    const maximum = Math.max(minimum, bounds.width - 320);
    setSidebarWidth(Math.min(maximum, Math.max(minimum, nextWidth)));
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const stopResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const visibleTabs = session.tabs.filter((tab) => tab.windowId === 1);

  const tabSpaceIds = session.browserState.tabSpaceIds;
  const spaceColours = session.browserState.spaceColours;
  const activeSpaceId = session.activeSpaceId;

  const findSpaceNodes = (nodes: typeof session.browserState.bookmarkTree): typeof session.browserState.bookmarkTree => {
    for (const node of nodes) {
      if (node.id === 'hyper-spaces') return node.children ?? [];
      const found = findSpaceNodes(node.children ?? []);
      if (found.length) return found;
    }
    return [];
  };
  const spaceNodes = findSpaceNodes(session.browserState.bookmarkTree);
  const spaceColour = (spaceId: string) => {
    const colour = spaceColours[spaceId];
    return colour ? `var(--tab-group-${colour})` : 'var(--tab-group-grey)';
  };
  const tabGroupStyle = (spaceId: string) => ({ '--tab-group-colour': spaceColour(spaceId) }) as CSSProperties;

  return (
    <div
      className="hyper-browser-window"
      aria-label={`Hyper live browser sandbox styled as ${appearance.label}`}
      data-browser={appearance.browser}
      data-platform={appearance.platform}
      data-theme={appearance.theme}
      style={{ '--active-tab-group-colour': spaceColour(activeSpaceId) } as CSSProperties}
    >
      <div className="hyper-browser-titlebar">
        <div className="browser-window-controls" aria-hidden="true"><i /><i /><i /></div>
        <span className="browser-window-title"><i /> {appearance.label} — {titleFor(session.activeTab)}</span>
        <span className="browser-window-actions" aria-hidden="true"><button tabIndex={-1}><Minus size={12} strokeWidth={1.8} /></button><button tabIndex={-1}><Square size={10} strokeWidth={1.8} /></button><button tabIndex={-1}><X size={12} strokeWidth={1.8} /></button></span>
      </div>

      <div className="hyper-browser-tabs" role="tablist" aria-label="Browser tabs">
        {spaceNodes.map((space) => {
          const groupTabs = visibleTabs.filter((tab) => tabSpaceIds[tab.id ?? -1] === space.id);
          if (!groupTabs.length) return null;
          const expanded = space.id === activeSpaceId;
          return (
            <div
              key={space.id}
              className={`browser-tab-group${expanded ? ' is-expanded' : ' is-collapsed'}`}
              style={tabGroupStyle(space.id)}
              role="group"
              aria-label={space.title}
            >
              {expanded ? groupTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={tab.active}
                  className={`browser-tab-button${tab.active ? ' is-active' : ''}`}
                  onClick={() => void session.controls.activateTab(tab)}
                  title={titleFor(tab)}
                >
                  <span>{titleFor(tab)}</span>
                  <small
                    role="button"
                    aria-label={`Close ${titleFor(tab)}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (tab.id !== undefined) void session.controls.closeTab(tab.id);
                    }}
                  ><X size={10} /></small>
                </button>
              )) : (
                <button
                  type="button"
                  className="browser-tab-group-collapsed"
                  onClick={() => void session.controls.setActiveSpace(space.id)}
                  aria-label={`Expand ${space.title} tab group`}
                  title={`${space.title} · ${groupTabs.length} tab${groupTabs.length === 1 ? '' : 's'}`}
                >
                  <span className="browser-tab-group-dot" />
                  <span className="browser-tab-group-count">{groupTabs.length}</span>
                </button>
              )}
            </div>
          );
        })}
        <button type="button" className="browser-tab-add" onClick={() => void session.controls.createTab()} aria-label="New browser tab"><Plus size={16} strokeWidth={1.8} /></button>
      </div>

      <div className="hyper-browser-toolbar">
        <button type="button" className="browser-toolbar-button" onClick={() => void session.controls.back()} aria-label="Go back">
          <ArrowLeft />
        </button>
        <button type="button" className="browser-toolbar-button" onClick={() => void session.controls.forward()} aria-label="Go forward">
          <ArrowRight />
        </button>
        <form className="browser-address" onSubmit={navigate}>
          <span aria-hidden="true">●</span>
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              event.stopPropagation();
            }}
            onKeyUp={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              event.stopPropagation();
              void session.controls.navigate(event.currentTarget.value, session.activeTab?.id);
            }}
            aria-label="Browser address"
            spellCheck={false}
          />
        </form>
        <button type="button" className="browser-toolbar-button" onClick={() => void session.controls.navigate(address, session.activeTab?.id)} aria-label="Go to address"><CornerDownLeft size={15} strokeWidth={1.8} /></button>
        <button type="button" className="browser-toolbar-button" onClick={() => void session.controls.reload()} aria-label="Reload page"><RotateCw size={15} strokeWidth={1.8} /></button>
        <button type="button" className="browser-toolbar-button" onClick={() => void session.controls.bookmarkCurrentPage(session.activeTab?.id)} aria-label="Bookmark current page"><Bookmark size={15} strokeWidth={1.8} /></button>
      </div>

      <div
        ref={contentRef}
        className="hyper-browser-content"
        style={sidebarWidth === null ? undefined : { gridTemplateColumns: `minmax(0, 1fr) ${sidebarWidth}px` }}
      >
        <PagePreview tab={session.activeTab} />
        <aside className="browser-extension" aria-label="Hyper extension">
          <div
            className="browser-content-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            onPointerDown={startResize}
            onPointerMove={resizeSidebar}
            onPointerUp={stopResize}
            onPointerCancel={stopResize}
          />
          <iframe
            src="/demo/sidebar"
            className="browser-extension-iframe"
            title="Browser extension"
            aria-label="Hyper extension content"
          />
        </aside>
      </div>
    </div>
  );
}
