import App from '../sidepanel/App';
import { mountApp } from '../sidepanel/components/AppErrorBoundary';
import '../sidepanel/style.css';

mountApp(App, 'The Hyper sidebar', { placement: 'sidebar', reloadedMessage: 'Reload this page to use Hyper here.' });
