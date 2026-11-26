'use client';

import { SidebarApp } from 'hyper-sidebar/demo';
import { useDemoBrowserSession } from '../useDemoBrowserSession';

export default function SidebarClient() {
  const session = useDemoBrowserSession();
  return <SidebarApp browserState={session.browserState} />;
}
