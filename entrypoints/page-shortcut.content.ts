import {
  closePageSearchOverlayMessageType,
  focusPageSearchOverlayMessageType,
  isPageOpenShortcut,
  openHyperFromPageMessageType,
  pageSearchOverlayReadyMessageType,
  pageSearchOverlayLayoutMessageType,
  pageSearchOverlayThemeMessageType,
  searchOverlayUrl,
  showPageSearchOverlayMessageType,
  type SearchOverlaySource,
} from './lib/pageShortcut';
import {
  inspectFrameMedia,
  isMediaControlMessage,
  mediaPlaybackChangedMessageType,
  setFrameMediaPlayback,
} from './lib/mediaControl';
import { capturePageText, isCapturePageTextMessage } from './lib/tabContentCapture';
import { createInPageSidebarHost, createShadowHost, pinnedHostCss } from './inpage/host';

interface SampledColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

function sampleCssColor(value: string): SampledColor | undefined {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return undefined;
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data;
  return { red, green, blue, alpha: alpha / 255 };
}

function compositeColor(foreground: SampledColor, background: SampledColor): SampledColor {
  const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha);
  if (alpha === 0) return { red: 0, green: 0, blue: 0, alpha: 0 };
  const compositeChannel = (foregroundChannel: number, backgroundChannel: number) => (
    (foregroundChannel * foreground.alpha +
      backgroundChannel * background.alpha * (1 - foreground.alpha)) / alpha
  );
  return {
    red: compositeChannel(foreground.red, background.red),
    green: compositeChannel(foreground.green, background.green),
    blue: compositeChannel(foreground.blue, background.blue),
    alpha,
  };
}

function relativeLuminance({ red, green, blue }: SampledColor) {
  const linearise = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearise(red) + 0.7152 * linearise(green) + 0.0722 * linearise(blue);
}

function pageHasDarkBackground() {
  const rootStyle = getComputedStyle(document.documentElement);
  const bodyStyle = document.body ? getComputedStyle(document.body) : undefined;
  const pageDeclaresDarkScheme = rootStyle.colorScheme.trim().split(/\s+/)[0] === 'dark';
  let background: SampledColor = pageDeclaresDarkScheme
    ? { red: 18, green: 18, blue: 18, alpha: 1 }
    : { red: 255, green: 255, blue: 255, alpha: 1 };
  const rootBackground = sampleCssColor(rootStyle.backgroundColor);
  const bodyBackground = bodyStyle && sampleCssColor(bodyStyle.backgroundColor);
  if (rootBackground) background = compositeColor(rootBackground, background);
  if (bodyBackground) background = compositeColor(bodyBackground, background);

  const hasBackgroundImage = rootStyle.backgroundImage !== 'none' ||
    (bodyStyle?.backgroundImage !== undefined && bodyStyle.backgroundImage !== 'none');
  if (hasBackgroundImage) {
    const textColor = sampleCssColor(bodyStyle?.color ?? rootStyle.color);
    if (textColor && relativeLuminance(textColor) > 0.6) return true;
  }
  return relativeLuminance(background) < 0.18;
}

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: true,
  runAt: 'document_start',
  main() {
    const extensionOrigin = browser.runtime.getURL('').replace(/\/$/, '');
    const topFrame = window === window.top;
    const inPageSidebar = createInPageSidebarHost();
    if (topFrame) inPageSidebar.start();
    let closeOverlay: (() => void) | undefined;
    let overlayHost: HTMLDivElement | undefined;
    let overlayFrame: HTMLIFrameElement | undefined;
    let overlayPanel: HTMLElement | undefined;
    let overlaySourceUrl: string | undefined;
    const syncOverlayPageBackground = (darkPage: boolean) => {
      if (overlayHost) overlayHost.dataset.pageBackground = darkPage ? 'dark' : 'light';
      overlayFrame?.contentWindow?.postMessage(
        { type: pageSearchOverlayThemeMessageType, darkPage },
        extensionOrigin,
      );
    };
    const focusOverlay = () => {
      overlayFrame?.contentWindow?.focus();
      overlayFrame?.contentWindow?.postMessage(
        { type: focusPageSearchOverlayMessageType },
        extensionOrigin,
      );
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeOverlay?.();
    };
    const armOverlayClose = (previouslyFocused: HTMLElement | undefined) => {
      document.addEventListener('keydown', onEscape, true);
      closeOverlay = () => {
        document.removeEventListener('keydown', onEscape, true);
        if (overlayHost) overlayHost.dataset.open = 'false';
        closeOverlay = undefined;
        window.focus();
        if (previouslyFocused?.isConnected) {
          previouslyFocused.focus({ preventScroll: true });
        }
      };
    };
    const showOverlay = (source: SearchOverlaySource) => {
      if (!topFrame) return;
      if (closeOverlay) {
        syncOverlayPageBackground(pageHasDarkBackground());
        focusOverlay();
        return;
      }
      const previouslyFocused = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
      const darkPage = pageHasDarkBackground();
      const sourceUrl = searchOverlayUrl(browser.runtime.getURL('/newtab.html'), source);
      const overlayUrl = new URL(sourceUrl);
      if (darkPage) overlayUrl.searchParams.set('pageBackground', 'dark');
      if (overlayHost && overlayFrame && overlayPanel) {
        syncOverlayPageBackground(darkPage);
        if (overlaySourceUrl !== sourceUrl) {
          overlayPanel.classList.remove('is-ready');
          delete overlayHost.dataset.ready;
          overlayFrame.src = overlayUrl.href;
          overlaySourceUrl = sourceUrl;
        }
        overlayHost.dataset.open = 'true';
        if (!overlayHost.isConnected) document.documentElement.append(overlayHost);
        armOverlayClose(previouslyFocused);
        focusOverlay();
        return;
      }
      const { host, shadow } = createShadowHost('hyper-search-overlay-host', `
        :host {${pinnedHostCss(2147483647)}
          /* The overlay page's top padding: room above the mark for its shadows, which blur out to about 1.5x their blur radius. Equals .newtab-shell.is-search-overlay's. */
          --hyper-overlay-inset: 140px;
          /* The new tab's mark top (.newtab-shell padding) less that inset, so both draw in the same place. */
          --hyper-overlay-panel-top: calc(clamp(120px, 30vh, 300px) - var(--hyper-overlay-inset));
          box-sizing: border-box;
          font-family: "Avenir Next", "Segoe UI Variable", "Trebuchet MS", sans-serif;
          isolation: isolate;
          transform: translateZ(0);
        }
        @media (max-height: 620px) {
          :host { --hyper-overlay-panel-top: calc(72px - var(--hyper-overlay-inset)); }
        }
        :host([data-open='false']) { display: none !important; }
        .backdrop {
          position: absolute;
          inset: 0;
          background: transparent;
        }
        .panel {
          position: absolute;
          top: var(--hyper-overlay-panel-top);
          left: 0;
          /* Full width, so the overlay page's 100vw, and its field width, equal the new tab's. */
          width: 100%;
          /* The mark, gap and field take 104px; below them the deepest field shadow needs about 280px. */
          height: min(calc(var(--hyper-overlay-inset) + 390px), calc(100vh - var(--hyper-overlay-panel-top)));
          overflow: hidden;
          background: transparent;
          isolation: isolate;
        }
        .panel.is-expanded {
          /* Results and their shadow may reach the viewport edge, where the frame's clip cannot show. */
          height: calc(100vh - var(--hyper-overlay-panel-top));
        }
        iframe {
          display: block;
          position: relative;
          z-index: 1;
          width: 100%;
          height: 100%;
          border: 0;
          background: transparent;
          /* Must equal the overlay document's; a mismatch makes Chrome paint the frame opaque. */
          color-scheme: light dark;
          opacity: 0;
          transition: opacity 100ms ease-out;
        }
        .panel.is-ready iframe { opacity: 1; }
        .placeholder {
          position: absolute;
          inset: 0;
          z-index: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 18px;
          padding: var(--hyper-overlay-inset) 16px 24px;
          color: #25292a;
          background: transparent;
          pointer-events: none;
          transition: opacity 100ms ease-out, visibility 100ms step-end;
        }
        .panel.is-ready .placeholder {
          visibility: hidden;
          opacity: 0;
        }
        .placeholder-brand {
          position: relative;
          display: grid;
          place-items: center;
          flex: none;
          width: 34px;
          height: 34px;
          overflow: hidden;
          border: 1px solid rgba(30, 81, 72, 0.26);
          background: #fff;
          border-radius: 8px;
        }
        .placeholder-brand::before {
          --hyper-mark-angle: 150deg;
          position: absolute;
          inset: 0;
          display: grid;
          place-items: center;
          content: '𝒉';
          color: transparent;
          background: conic-gradient(
            from var(--hyper-mark-angle) at 100% 75%,
            #187c70 0%,
            #327fc4 20%,
            #b84f91 40%,
            #df963f 60%,
            #df963f 80%,
            #187c70 100%
          );
          background-clip: text;
          font-family: 'STIX Two Math', 'Cambria Math', 'Times New Roman', serif;
          font-size: 27px;
          line-height: 1;
          padding-top: 2px;
          -webkit-background-clip: text;
        }
        .placeholder-field {
          /* The deeper shadow a dark page or a dark scheme needs to lift the field. */
          --deep-shadow:
            0 38px 132px rgba(0, 0, 0, 0.8),
            0 13px 54px rgba(0, 0, 0, 0.64);
          flex: none;
          width: min(640px, 100%);
          height: 52px;
          overflow: hidden;
          border: 1px solid rgba(35, 45, 48, 0.14);
          border-radius: 8px;
          background: #f8faf9;
          box-shadow:
            0 32px 110px rgba(2, 5, 6, 0.62),
            0 10px 44px rgba(2, 5, 6, 0.46);
        }
        :host([data-page-background='dark']) .placeholder-field {
          box-shadow: var(--deep-shadow);
        }
        .placeholder-pulse {
          display: block;
          width: 36%;
          height: 100%;
          background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.62), transparent);
          animation: hyper-placeholder-pulse 900ms ease-in-out infinite;
        }
        @media (prefers-color-scheme: dark) {
          .placeholder {
            color: #edf1f1;
            background: transparent;
          }
          .placeholder-field {
            border-color: rgba(222, 232, 235, 0.14);
            background: #202b2f;
            box-shadow: var(--deep-shadow);
          }
          :host([data-page-background='dark']) .placeholder-field {
            box-shadow:
              0 42px 148px rgba(0, 0, 0, 0.88),
              0 15px 62px rgba(0, 0, 0, 0.72);
          }
          .placeholder-pulse {
            background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.1), transparent);
          }
        }
        @media (prefers-reduced-motion: no-preference) {
          :host { animation: hyper-overlay-in 140ms ease-out; }
          .panel { animation: hyper-panel-in 180ms cubic-bezier(.2,.75,.25,1); }
          .placeholder-brand::before {
            animation: hyper-mark-gradient-spin 40s linear infinite;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .placeholder-pulse { animation: none; opacity: 0.32; }
        }
        @keyframes hyper-overlay-in { from { opacity: 0; } }
        @keyframes hyper-panel-in { from { transform: translateY(10px) scale(.985); } }
        @property --hyper-mark-angle {
          syntax: '<angle>';
          inherits: false;
          initial-value: 150deg;
        }
        @keyframes hyper-mark-gradient-spin {
          from { --hyper-mark-angle: 150deg; }
          to { --hyper-mark-angle: 510deg; }
        }
        @keyframes hyper-placeholder-pulse {
          from { transform: translateX(-100%); }
          to { transform: translateX(280%); }
        }
      `);
      overlayHost = host;
      host.dataset.open = 'true';
      host.dataset.pageBackground = darkPage ? 'dark' : 'light';
      const backdrop = document.createElement('div');
      backdrop.className = 'backdrop';
      const panel = document.createElement('section');
      overlayPanel = panel;
      panel.className = 'panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      panel.setAttribute('aria-label', 'Hyper Search');
      const iframe = document.createElement('iframe');
      overlayFrame = iframe;
      iframe.title = 'Hyper Search';
      iframe.setAttribute('allowtransparency', 'true');
      iframe.src = overlayUrl.href;
      overlaySourceUrl = sourceUrl;
      const markReady = () => {
        panel.classList.add('is-ready');
        host.dataset.ready = 'true';
        if (closeOverlay) focusOverlay();
      };
      iframe.addEventListener('load', () => {
        syncOverlayPageBackground(pageHasDarkBackground());
        markReady();
      });
      const placeholder = document.createElement('div');
      placeholder.className = 'placeholder';
      placeholder.setAttribute('aria-hidden', 'true');
      placeholder.innerHTML = `
        <span class="placeholder-brand"></span>
        <span class="placeholder-field"><span class="placeholder-pulse"></span></span>
      `;
      panel.append(iframe, placeholder);
      shadow.append(backdrop, panel);

      const onFrameMessage = (event: MessageEvent) => {
        if (event.source !== iframe.contentWindow || event.origin !== extensionOrigin) return;
        const data: unknown = event.data;
        if (!data || typeof data !== 'object' || !('type' in data)) return;
        if (data.type === closePageSearchOverlayMessageType) closeOverlay?.();
        else if (data.type === pageSearchOverlayReadyMessageType) markReady();
        else if (data.type === pageSearchOverlayLayoutMessageType) {
          const expanded = 'expanded' in data && data.expanded === true;
          panel.classList.toggle('is-expanded', expanded);
          host.dataset.expanded = String(expanded);
        }
      };
      armOverlayClose(previouslyFocused);
      backdrop.addEventListener('click', () => closeOverlay?.());
      window.addEventListener('message', onFrameMessage);
      document.documentElement.append(host);
    };

    browser.runtime.onMessage.addListener((message: unknown) => {
      if (topFrame && inPageSidebar.handleMessage(message)) return undefined;
      if (
        message &&
        typeof message === 'object' &&
        'type' in message &&
        message.type === showPageSearchOverlayMessageType &&
        'sourceTabId' in message &&
        typeof message.sourceTabId === 'number' &&
        'sourceWindowId' in message &&
        typeof message.sourceWindowId === 'number'
      ) {
        showOverlay({
          tabId: message.sourceTabId,
          windowId: message.sourceWindowId,
        });
        return Promise.resolve();
      }
      if (isCapturePageTextMessage(message)) return topFrame ? capturePageText() : undefined;
      if (!isMediaControlMessage(message)) return undefined;
      if (message.action === 'inspect') return Promise.resolve(inspectFrameMedia());
      return setFrameMediaPlayback(message.elementIndex, message.state);
    });
    const announceMediaPlaybackChange = (event: Event) => {
      if (!(event.target instanceof HTMLMediaElement)) return;
      void browser.runtime.sendMessage({
        type: mediaPlaybackChangedMessageType,
        state: event.type === 'play' ? 'playing' : 'paused',
      }).catch(() => undefined);
    };
    for (const type of ['play', 'pause', 'ended']) document.addEventListener(type, announceMediaPlaybackChange, true);
    window.addEventListener('keydown', (event) => {
      if (!isPageOpenShortcut(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      void browser.runtime.sendMessage({ type: openHyperFromPageMessageType })
        .catch((error) => console.error('Unable to open Hyper.', error));
    }, true);
  },
});