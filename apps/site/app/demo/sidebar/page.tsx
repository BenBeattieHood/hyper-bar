'use client';

import dynamic from 'next/dynamic';

const SidebarClient = dynamic(() => import('./SidebarClient'), { ssr: false });

export default function SidebarFramePage() {
  return <SidebarClient />;
}
