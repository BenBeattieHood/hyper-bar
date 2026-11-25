import { describe, expect, it } from 'vitest';
import { resolveActiveSpaceHold } from './activeSpaceHold';

describe('resolveActiveSpaceHold', () => {
  it('shows the projection when nothing is held', () => {
    expect(resolveActiveSpaceHold(null, 'space-a')).toEqual({
      activeSpaceId: 'space-a',
      pendingActiveSpaceId: null,
    });
  });

  it('overrides the projection with the space being switched to', () => {
    // The model still names the space being left, so the view holds the target.
    expect(resolveActiveSpaceHold('space-b', 'space-a')).toEqual({
      activeSpaceId: 'space-b',
      pendingActiveSpaceId: 'space-b',
    });
  });

  it('retires the hold the moment the model reports the target space', () => {
    expect(resolveActiveSpaceHold('space-b', 'space-b')).toEqual({
      activeSpaceId: 'space-b',
      pendingActiveSpaceId: null,
    });
  });

  it('shows nothing when neither the hold nor the projection names a space', () => {
    expect(resolveActiveSpaceHold(null, null)).toEqual({
      activeSpaceId: null,
      pendingActiveSpaceId: null,
    });
  });

  it('keeps holding when the projection has no active space yet', () => {
    expect(resolveActiveSpaceHold('space-b', null)).toEqual({
      activeSpaceId: 'space-b',
      pendingActiveSpaceId: 'space-b',
    });
  });
});
