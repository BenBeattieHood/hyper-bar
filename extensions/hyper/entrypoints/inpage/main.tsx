import { SidebarApp } from '../sidepanel/App';
import { mountApp } from '../sidepanel/components/AppErrorBoundary';
import { useBrowserState } from '../sidepanel/hooks/useBrowserState';
import '../sidepanel/style.css';

function App() {
  return <SidebarApp browserState={useBrowserState()} />;
}

mountApp(App, 'The Hyper sidebar', { placement: 'sidebar', reloadedMessage: 'Reload this page to use Hyper here.' });
