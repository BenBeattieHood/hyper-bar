'use client';

export function SidebarApp() {
  return (
    <iframe
      className="browser-extension-frame"
      src="/demo/sidebar?theme=dark"
      title="Hyper browser extension"
    />
  );
}
