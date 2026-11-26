import { SidebarApp } from './App';
import { useBrowserState } from './hooks/useBrowserState';
import { mountApp } from './components/AppErrorBoundary';
import '@hyper/ui/styles.css';
import './style.css';

function App() {
  return <SidebarApp browserState={useBrowserState()} />;
}

mountApp(App, 'The Hyper sidebar', { placement: 'sidebar' });
