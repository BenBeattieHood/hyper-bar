import { describe, expect, it, vi } from 'vitest';
import {
  createSpaceIndicatorActions,
  shouldUseRemoteSpaceAction,
} from './spaceIndicatorActions';

describe('shouldUseRemoteSpaceAction', () => {
  it('gives a local match precedence over remote presence', () => {
    expect(shouldUseRemoteSpaceAction(['two'], new Set(['two']), 'two')).toBe(false);
    expect(shouldUseRemoteSpaceAction(['two'], new Set(['one']), 'two')).toBe(true);
  });
});

describe('space indicator actions', () => {
  it('focuses a remote tab normally and moves it with the modifier action', () => {
    const focusRemoteTab = vi.fn(async () => undefined);
    const moveRemoteTabToWindow = vi.fn(async () => undefined);
    const clearSelectedAfterSpy = vi.fn();
    const clearSelectedAfter = <Result,>(operation: Promise<Result>): Promise<Result> => {
      clearSelectedAfterSpy(operation);
      return operation;
    };
    const actions = createSpaceIndicatorActions({
      clearSelectedAfter,
      closeTabsInSpace: vi.fn(async () => undefined),
      focusRemoteTab,
      moveRemoteTabToWindow,
      openBookmark: vi.fn(async () => undefined),
      showNotice: vi.fn(),
    });
    const source = { bookmarkId: 'visible-bookmark', kind: 'bookmark' as const };

    actions.openRemote(source, 'two', false);
    actions.openRemote(source, 'two', true);

    expect(focusRemoteTab).toHaveBeenCalledTimes(1);
    expect(focusRemoteTab).toHaveBeenCalledWith(source, 'two');
    expect(moveRemoteTabToWindow).toHaveBeenCalledTimes(1);
    expect(moveRemoteTabToWindow).toHaveBeenCalledWith(source, 'two');
    expect(clearSelectedAfterSpy).toHaveBeenCalledTimes(2);
  });

  it('closes the page in a space and shows why it could not', async () => {
    const closeTabsInSpace = vi.fn(async () => undefined)
      .mockRejectedValueOnce(new Error('Those tabs could not be closed.'));
    const showNotice = vi.fn();
    const actions = createSpaceIndicatorActions({
      clearSelectedAfter: (operation) => operation,
      closeTabsInSpace,
      focusRemoteTab: vi.fn(async () => undefined),
      moveRemoteTabToWindow: vi.fn(async () => undefined),
      openBookmark: vi.fn(async () => undefined),
      showNotice,
    });
    const source = { kind: 'tab' as const, tabId: 7 };

    actions.closeInSpace(source, 'two');
    actions.closeInSpace(source, 'three');

    expect(closeTabsInSpace).toHaveBeenNthCalledWith(1, source, 'two');
    expect(closeTabsInSpace).toHaveBeenNthCalledWith(2, source, 'three');
    await vi.waitFor(() => expect(showNotice).toHaveBeenCalledTimes(1));
    expect(showNotice).toHaveBeenCalledWith('Those tabs could not be closed.');
  });
});