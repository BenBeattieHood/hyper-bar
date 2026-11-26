'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { BrowserTab } from 'hyper-sidebar/demo';
import { SidebarApp } from 'hyper-sidebar/demo';
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

  useEffect(() => setAddress(session.address), [session.address]);

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    void session.controls.navigate(address, session.activeTab?.id);
  };

  const visibleTabs = session.tabs.filter((tab) => tab.windowId === 1);

  return (
    <div
      className="hyper-browser-window"
      aria-label={`Hyper live browser sandbox styled as ${appearance.label}`}
      data-browser={appearance.browser}
      data-platform={appearance.platform}
      data-theme={appearance.theme}
    >
      <div className="hyper-browser-titlebar">
        <div className="browser-window-controls" aria-hidden="true"><i /><i /><i /></div>
        <span className="browser-window-title"><i /> {appearance.label} — {titleFor(session.activeTab)}</span>
        <span className="browser-window-actions" aria-hidden="true"><button tabIndex={-1}>−</button><button tabIndex={-1}>□</button><button tabIndex={-1}>×</button></span>
      </div>

      <div className="hyper-browser-tabs" role="tablist" aria-label="Browser tabs">
        {visibleTabs.map((tab) => (
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
            >×</small>
          </button>
        ))}
        <button type="button" className="browser-tab-add" onClick={() => void session.controls.createTab()} aria-label="New browser tab">＋</button>
      </div>

      <div className="hyper-browser-toolbar">
        <button type="button" className="browser-toolbar-button" onClick={() => void session.controls.back()} aria-label="Go back">←</button>
        <button type="button" className="browser-toolbar-button" onClick={() => void session.controls.forward()} aria-label="Go forward">→</button>
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
        <button type="button" className="browser-toolbar-button" onClick={() => void session.controls.navigate(address, session.activeTab?.id)} aria-label="Go to address">↵</button>
        <button type="button" className="browser-toolbar-button" onClick={() => void session.controls.reload()} aria-label="Reload page">↻</button>
        <button type="button" className="browser-toolbar-button" onClick={() => void session.controls.bookmarkCurrentPage(session.activeTab?.id)} aria-label="Bookmark current page">☆</button>
      </div>

      <div className="hyper-browser-content">
        <PagePreview tab={session.activeTab} />
        <aside className="browser-extension" aria-label="Hyper extension">
          <SidebarApp browserState={session.browserState} />
        </aside>
      </div>
    </div>
  );
}
