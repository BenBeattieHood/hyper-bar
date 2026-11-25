import App from './App';
import { mountApp } from '../sidepanel/components/AppErrorBoundary';
import { closePageSearchOverlay, pageSearchOverlayThemeMessageType } from '../lib/pageShortcut';
import './style.css';

const searchParams = new URL(location.href).searchParams;
const searchOverlay = searchParams.get('mode') === 'search-overlay';
const setDarkPageOverlay = (darkPage: boolean) => {
  document.documentElement.classList.toggle('search-overlay-dark-page', darkPage);
};
if (searchOverlay) {
  document.documentElement.classList.add('search-overlay-document');
  setDarkPageOverlay(searchParams.get('pageBackground') === 'dark');
  window.addEventListener('message', (event) => {
    if (
      event.source === window.parent &&
      event.data?.type === pageSearchOverlayThemeMessageType
    ) {
      setDarkPageOverlay(event.data.darkPage === true);
    }
  });
}

mountApp(App, 'The Hyper new tab', {
  onBeforeReload: searchOverlay ? closePageSearchOverlay : undefined,
  placement: 'page',
});
