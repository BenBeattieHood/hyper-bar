/** The sidebar also runs framed inside webpages, from `inpage.html`. */
export const isInPageSidebar = () => location.pathname.endsWith('/inpage.html');

export type SidebarSide = 'left' | 'right';

export async function detectSidebarSide(): Promise<SidebarSide> {
  if (isInPageSidebar()) return 'left';
  if (typeof browser.sidePanel?.getLayout === 'function') {
    try {
      const { side } = await browser.sidePanel.getLayout();
      if (side === 'left' || side === 'right') return side;
    } catch {}
  }

  const sidebarViewportX = (window as Window & { mozInnerScreenX?: number })
    .mozInnerScreenX;
  if (typeof sidebarViewportX === 'number') {
    try {
      const owningWindow = await browser.windows.getCurrent();
      if (
        typeof owningWindow.left === 'number' &&
        typeof owningWindow.width === 'number'
      ) {
        const sidebarCenter = sidebarViewportX + window.innerWidth / 2;
        const browserCenter = owningWindow.left + owningWindow.width / 2;
        return sidebarCenter < browserCenter ? 'left' : 'right';
      }
    } catch {}
  }

  return 'right';
}
