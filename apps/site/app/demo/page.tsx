'use client';

import dynamic from 'next/dynamic';

const DemoClient = dynamic(() => import('./DemoClient'), {
  ssr: false,
  loading: () => (
    <main className="loading-shell" aria-label="Loading Hyper demo">
      <span className="brand-mark" aria-hidden="true" />
    </main>
  ),
});

export default function HyperDemoPage() {
  return <DemoClient />;
}
