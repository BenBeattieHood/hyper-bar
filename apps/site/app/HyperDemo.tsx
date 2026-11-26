'use client';

// Keep the real Hyper viewport isolated from the marketing page's CSS and document sizing.
export default function HyperDemo() {
  return (
    <iframe
      className="hyper-production-demo"
      src="/demo"
      title="Hyper browser extension live demo"
      allow="clipboard-read; clipboard-write"
    />
  );
}
