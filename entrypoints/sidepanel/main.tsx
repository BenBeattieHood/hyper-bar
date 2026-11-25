import App from './App';
import { mountApp } from './components/AppErrorBoundary';
import './style.css';

mountApp(App, 'The Hyper sidebar', { placement: 'sidebar' });
