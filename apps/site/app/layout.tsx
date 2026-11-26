import type { Metadata } from 'next';
import './root.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://hyperbar.app'),
  title: 'Hyper | Spatial Browser Workspaces',
  description: 'Hyper is an Arc-inspired browser extension for tabs, spaces, and durable context.',
  alternates: {
    canonical: '/',
  },
  openGraph: {
    title: 'Hyper | Spatial Browser Workspaces',
    description: 'Hyper brings your tabs, bookmarks, and history into one calm, searchable space.',
    url: '/',
    siteName: 'Hyper',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'Hyper | Spatial Browser Workspaces',
    description: 'Hyper brings your tabs, bookmarks, and history into one calm, searchable space.',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
