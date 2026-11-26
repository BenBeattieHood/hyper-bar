import {
  clampInPageSidebarWidth,
  IN_PAGE_SIDEBAR_DEFAULT_WIDTH,
  IN_PAGE_SIDEBAR_MAX_WIDTH,
  IN_PAGE_SIDEBAR_MIN_WIDTH,
  IN_PAGE_TRIGGER_WIDTH,
  inPageSidebarRequestType,
  isInPageSidebarState,
  type InPageSidebarState,
} from '../lib/inPageSidebarProtocol';

export const IN_PAGE_SIDEBAR_HIDE_DELAY_MS = 500;
// The sidebar loads out of sight while the mark is hovered, so a click only
// slides it in. A loaded frame lingers this long unopened or after closing, so
// reopening is as quick; a hidden page drops it at once.
const IN_PAGE_SIDEBAR_KEEP_ALIVE_MS = 60_000;
// Leaves page beside a wide sidebar to click, which is how it closes.
const PAGE_MARGIN = 48;
const KEY_STEP = 16;
const resizeKeys = new Set(['ArrowLeft', 'ArrowRight', 'End', 'Home']);

/** Pins a shadow host over the whole page; page rules outrank :host unless important. */
export const pinnedHostCss = (zIndex: number) => `
    all: initial;
    position: fixed !important;
    inset: 0 !important;
    z-index: ${zIndex} !important;
    display: block !important;
    margin: 0 !important;
    padding: 0 !important;`;

/** A page element whose closed shadow root holds Hyper's own styled UI. */
export function createShadowHost(id: string, css: string) {
  const host = document.createElement('div');
  host.id = id;
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `${css}\n  *, *::before, *::after { box-sizing: border-box; }\n`;
  shadow.append(style);
  return { host, shadow };
}

const styles = `
  :host {${pinnedHostCss(2147483646)}
    --mark-left: 14px;
    --mark-size: ${IN_PAGE_TRIGGER_WIDTH}px;
    /* Where the glyph sits, above the foot of the page. */
    --mark-centre: 28px;
    --mark-raise: 0px;
    --mark-move: 300ms cubic-bezier(.4, 0, .2, 1);
    --glass-margin: 16px;
    /* The trigger's frost remains more pronounced than the sidebar's. */
    --mark-frost-reach: calc(var(--mark-left) + var(--mark-size) + var(--glass-margin));
    --sidebar-frost-reach: 32px;
    --mark-frost-fade: #000 35%, rgba(0, 0, 0, 0.8) 55%, rgba(0, 0, 0, 0.45) 72%,
      rgba(0, 0, 0, 0.15) 88%, transparent;
    --sidebar-frost-fade: rgba(0, 0, 0, 0.7) 0%, rgba(0, 0, 0, 0.3) 28%,
      rgba(0, 0, 0, 0.1) 55%, transparent 80%;
    pointer-events: none !important;
  }
  :host([data-raised='true']) { --mark-raise: 25vh; }
  .glass, .panel::after {
    background: rgba(255, 255, 255, 0.3);
    -webkit-backdrop-filter: blur(16px) saturate(1.4);
    backdrop-filter: blur(16px) saturate(1.4);
  }
  .glass {
    /* An oval centred on the page's left edge, level with the mark, so only its right half shows. */
    --glass-height: max(20vh, calc(var(--mark-size) + 50px));
    position: absolute;
    left: calc(-1 * var(--mark-frost-reach));
    bottom: calc(var(--mark-centre) - var(--glass-height) / 2);
    width: calc(2 * var(--mark-frost-reach));
    height: var(--glass-height);
    -webkit-mask-image: radial-gradient(closest-side, var(--mark-frost-fade));
    mask-image: radial-gradient(closest-side, var(--mark-frost-fade));
    transform: translateY(calc(-1 * var(--mark-raise)));
    opacity: 0;
    transition: opacity 180ms ease, transform var(--mark-move);
  }
  :host([data-hover='true']:not([data-open='true'])) .glass { opacity: 1; }
  .mark {
    --hyper-mark-angle: 150deg;
    position: absolute;
    left: 0;
    bottom: 0;
    display: grid;
    place-items: center;
    width: var(--mark-size);
    height: var(--mark-size);
    padding: 8px 25px 40px 20px;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: transparent;
    font: 31px / 1 'STIX Two Math', 'Cambria Math', 'Times New Roman', serif;
    cursor: pointer;
    pointer-events: auto;
    transform: translateY(calc(-1 * var(--mark-raise)));
    transition: opacity 160ms ease, filter 160ms ease, transform var(--mark-move);
    filter: grayscale(1) brightness(0.6);
  }
  .mark::before {
    content: '𝒉';
    background: conic-gradient(
      from var(--hyper-mark-angle) at 100% 75%,
      #187c70 0%, #327fc4 20%, #b84f91 40%, #df963f 60%, #df963f 80%, #187c70 100%
    );
    -webkit-background-clip: text;
    background-clip: text;
    filter: drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.35));
  }
  .mark:hover { filter: grayscale(0) brightness(1.1); }
  .mark:focus-visible { outline: 2px solid #327fc4; outline-offset: 2px; }
  :host([data-open='true']) .mark { opacity: 0; pointer-events: none; }
  .panel {
    position: absolute;
    inset: 0 auto 0 0;
    width: min(var(--panel-width, 360px), 100vw);
    background: #f4f6f5;
    pointer-events: none;
    /* Far enough that the frost past its edge is out of sight too. */
    transform: translateX(calc(-100% - var(--sidebar-frost-reach)));
    transition: transform 200ms cubic-bezier(.2, .75, .25, 1);
  }
  /* The mark's frost, falling away from the sidebar's edge over the page. */
  .panel::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 100%;
    width: var(--sidebar-frost-reach);
    -webkit-mask-image: linear-gradient(to right, var(--sidebar-frost-fade));
    mask-image: linear-gradient(to right, var(--sidebar-frost-fade));
    pointer-events: none;
  }
  :host([data-open='true']) .panel { transform: none; pointer-events: auto; }
  .panel iframe { display: block; width: 100%; height: 100%; border: 0; }
  /* The frame would otherwise swallow the pointer whenever a drag crosses it. */
  :host([data-resizing='true']) .panel iframe { pointer-events: none; }
  .edge {
    position: absolute;
    top: 0;
    right: -4px;
    bottom: 0;
    z-index: 1;
    width: 8px;
    cursor: ew-resize;
    touch-action: none;
  }
  .edge::after {
    content: '';
    position: absolute;
    inset: 0 3px;
    background: transparent;
    transition: background 120ms ease;
  }
  .edge:hover::after, .edge:focus-visible::after, :host([data-resizing='true']) .edge::after {
    background: #327fc4;
  }
  .edge:focus-visible { outline: none; }
  @media (prefers-color-scheme: dark) {
    .glass, .panel::after { background: rgba(20, 26, 28, 0.36); }
    .panel { background: #1b2225; }
  }
  @media (prefers-reduced-motion: reduce) {
    .glass, .mark, .panel, .edge::after { transition: none; }
  }
`;

export interface InPageSidebarHost {
  handleMessage(message: unknown): boolean;
  start(): void;
}

/**
 * Shows Hyper's sidebar inside a webpage while the browser's own sidebar is
 * closed: a mark in the bottom-left corner opens it, and a click elsewhere on
 * the page hides it again shortly after. Dragging its edge resizes it.
 * Right-clicking the mark moves it up the page, out of the way, and back.
 */
export function createInPageSidebarHost(): InPageSidebarHost {
  let host: HTMLDivElement | undefined;
  let panel: HTMLElement | undefined;
  let edge: HTMLElement | undefined;
  let frame: HTMLIFrameElement | undefined;
  let loading: Promise<boolean> | undefined;
  // Bumped on release, so a load still in flight cannot revive a dropped frame.
  let generation = 0;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  let width = IN_PAGE_SIDEBAR_DEFAULT_WIDTH;
  let drag: { moved: boolean; pointerId: number; startWidth: number; startX: number } | undefined;

  const request = async (action: 'open' | 'query' | 'resize') => {
    const state: unknown = await browser.runtime.sendMessage({
      action,
      type: inPageSidebarRequestType,
      ...(action === 'resize' ? { width } : {}),
    }).catch(() => undefined);
    return isInPageSidebarState(state) ? state : undefined;
  };
  // Replies can overtake each other, so only the newest request's state is applied;
  // otherwise a slow reply to an earlier resize could snap the width back.
  let latestStateRequest = 0;
  const requestState = async (action: 'open' | 'query' | 'resize') => {
    const id = ++latestStateRequest;
    const state = await request(action);
    return { current: id === latestStateRequest, state };
  };
  const applyLatest = (action: 'query' | 'resize') => void requestState(action)
    .then(({ current, state }) => { if (current) apply(state); });
  const isOpen = () => host?.dataset.open === 'true';
  const cancelHide = () => {
    clearTimeout(hideTimer);
    hideTimer = undefined;
  };
  const onPagePointerDown = (event: PointerEvent) => {
    if (host && event.composedPath().includes(host)) return;
    cancelHide();
    hideTimer = setTimeout(hide, IN_PAGE_SIDEBAR_HIDE_DELAY_MS);
  };
  const release = () => {
    generation += 1;
    clearTimeout(releaseTimer);
    loading = undefined;
    frame?.remove();
    frame = undefined;
  };
  const releaseLater = () => {
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => {
      if (!isOpen()) release();
    }, IN_PAGE_SIDEBAR_KEEP_ALIVE_MS);
  };
  function hide() {
    cancelHide();
    if (!host || !isOpen()) return;
    host.dataset.open = 'false';
    if (edge) edge.tabIndex = -1;
    document.removeEventListener('pointerdown', onPagePointerDown, true);
    releaseLater();
  }
  /** Loads the sidebar out of sight, once, so opening it only slides it in. */
  const load = () => {
    if (loading) return loading;
    const current = generation;
    loading = requestState('open').then(({ current: latest, state }) => {
      if (current !== generation) return false;
      if (latest) apply(state);
      if (!state?.available || !state.url || !panel) {
        loading = undefined;
        return false;
      }
      frame = document.createElement('iframe');
      frame.title = 'Hyper';
      frame.src = state.url;
      panel.prepend(frame);
      if (!isOpen()) releaseLater();
      return true;
    });
    return loading;
  };
  const show = async () => {
    if (!await load() || !host || !frame) return;
    clearTimeout(releaseTimer);
    host.dataset.open = 'true';
    host.dataset.hover = 'false';
    if (edge) edge.tabIndex = 0;
    document.addEventListener('pointerdown', onPagePointerDown, true);
    frame.focus();
  };
  const mount = () => {
    if (host) {
      if (!host.isConnected) document.documentElement.append(host);
      return;
    }
    const created = createShadowHost('hyper-in-page-sidebar-host', styles);
    host = created.host;
    host.dataset.open = 'false';
    const glass = document.createElement('div');
    glass.className = 'glass';
    const mark = document.createElement('button');
    mark.type = 'button';
    mark.className = 'mark';
    mark.title = 'Hyper';
    mark.setAttribute('aria-label', 'Open Hyper');
    mark.addEventListener('pointerenter', () => {
      if (host) host.dataset.hover = 'true';
      void load();
    });
    mark.addEventListener('pointerleave', () => { if (host) host.dataset.hover = 'false'; });
    mark.addEventListener('focus', () => void load());
    mark.addEventListener('click', () => void show());
    // Lifts the mark off whatever control the page keeps in that corner, or sets it back down.
    mark.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      if (host) host.dataset.raised = host.dataset.raised === 'true' ? 'false' : 'true';
    });
    panel = document.createElement('section');
    panel.className = 'panel';
    panel.setAttribute('aria-label', 'Hyper sidebar');
    panel.addEventListener('pointerenter', cancelHide);
    edge = createEdge();
    panel.append(edge);
    showWidth(width);
    created.shadow.append(glass, mark, panel);
    document.documentElement.append(host);
  };
  const showWidth = (next: number) => {
    width = next;
    panel?.style.setProperty('--panel-width', `${next}px`);
    edge?.setAttribute('aria-valuenow', String(next));
  };
  const fitWidth = (next: number) =>
    clampInPageSidebarWidth(Math.min(next, window.innerWidth - PAGE_MARGIN));
  const saveWidth = () => applyLatest('resize');
  const createEdge = () => {
    const element = document.createElement('div');
    element.className = 'edge';
    element.tabIndex = -1;
    element.setAttribute('role', 'separator');
    element.setAttribute('aria-label', 'Resize Hyper sidebar');
    element.setAttribute('aria-orientation', 'vertical');
    element.setAttribute('aria-valuemin', String(IN_PAGE_SIDEBAR_MIN_WIDTH));
    element.setAttribute('aria-valuemax', String(IN_PAGE_SIDEBAR_MAX_WIDTH));
    element.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !panel) return;
      event.preventDefault();
      element.setPointerCapture(event.pointerId);
      drag = {
        moved: false,
        pointerId: event.pointerId,
        startWidth: Math.round(panel.getBoundingClientRect().width),
        startX: event.clientX,
      };
      if (host) host.dataset.resizing = 'true';
    });
    element.addEventListener('pointermove', (event) => {
      if (drag?.pointerId !== event.pointerId) return;
      drag.moved = true;
      showWidth(fitWidth(drag.startWidth + event.clientX - drag.startX));
    });
    const endDrag = (event: PointerEvent) => {
      if (drag?.pointerId !== event.pointerId) return;
      const { moved } = drag;
      drag = undefined;
      if (host) host.dataset.resizing = 'false';
      if (moved) saveWidth();
    };
    element.addEventListener('pointerup', endDrag);
    element.addEventListener('pointercancel', endDrag);
    element.addEventListener('keydown', (event) => {
      if (!resizeKeys.has(event.key)) return;
      event.preventDefault();
      if (event.key === 'Home') showWidth(fitWidth(IN_PAGE_SIDEBAR_MIN_WIDTH));
      else if (event.key === 'End') showWidth(fitWidth(IN_PAGE_SIDEBAR_MAX_WIDTH));
      else showWidth(fitWidth(width + (event.key === 'ArrowRight' ? KEY_STEP : -KEY_STEP)));
    });
    // A held key repeats keydown but releases once, so one hold saves once.
    element.addEventListener('keyup', (event) => {
      if (resizeKeys.has(event.key)) saveWidth();
    });
    return element;
  };
  const apply = (state: InPageSidebarState | undefined) => {
    if (state?.available) {
      mount();
      if (state.width !== undefined && !drag) showWidth(state.width);
      return;
    }
    hide();
    release();
    host?.remove();
  };
  const refresh = () => applyLatest('query');

  return {
    handleMessage(message) {
      if (!isInPageSidebarState(message)) return false;
      apply(message);
      return true;
    },
    start() {
      refresh();
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          refresh();
          return;
        }
        hide();
        release();
      });
    },
  };
}
