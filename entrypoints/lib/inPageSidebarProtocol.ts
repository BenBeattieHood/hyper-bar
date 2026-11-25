import { isFiniteNumber, isRecord } from './collections';
export const inPageSidebarRequestType = 'hyper:in-page-sidebar';
export const inPageSidebarStateType = 'hyper:in-page-sidebar-state';

export const IN_PAGE_SIDEBAR_DEFAULT_WIDTH = 360;
export const IN_PAGE_TRIGGER_WIDTH = 38;
export const IN_PAGE_SIDEBAR_MIN_WIDTH = IN_PAGE_TRIGGER_WIDTH;
export const IN_PAGE_SIDEBAR_MAX_WIDTH = 1200;

/** Whole pixels within bounds every page shares; each page also caps it to its own width. */
export function clampInPageSidebarWidth(width: number): number {
  return Math.min(
    IN_PAGE_SIDEBAR_MAX_WIDTH,
    Math.max(IN_PAGE_SIDEBAR_MIN_WIDTH, Math.round(width)),
  );
}

/** A page's Hyper content script asking whether, and where, it may show the sidebar, or reporting a resize. */
export type InPageSidebarRequest =
  | { action: 'open' | 'query'; type: typeof inPageSidebarRequestType }
  | { action: 'resize'; type: typeof inPageSidebarRequestType; width: number };

/** The background's answer, also pushed to pages when the answer changes. */
export interface InPageSidebarState {
  available: boolean;
  type: typeof inPageSidebarStateType;
  url?: string;
  width?: number;
}

export function isInPageSidebarRequest(message: unknown): message is InPageSidebarRequest {
  if (!isRecord(message)) return false;
  const { action, type, width } = message as Record<string, unknown>;
  if (type !== inPageSidebarRequestType) return false;
  return action === 'resize' ? isFiniteNumber(width) : action === 'open' || action === 'query';
}

export function isInPageSidebarState(message: unknown): message is InPageSidebarState {
  if (!isRecord(message)) return false;
  const { available, type, url, width } = message as Partial<InPageSidebarState>;
  return type === inPageSidebarStateType &&
    typeof available === 'boolean' &&
    (url === undefined || typeof url === 'string') &&
    (width === undefined || isFiniteNumber(width));
}
