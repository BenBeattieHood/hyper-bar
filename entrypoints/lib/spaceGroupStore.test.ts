import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  forgetSpaceGroup,
  forgetWindowSpaceGroups,
  parseSpaceGroupKey,
  rememberSpaceGroup,
  spaceGroupId,
  spaceGroupKey,
  windowSpaceGroups,
} from './spaceGroupStore';
import { fakeStorageArea } from './testFixtures';

function installSession(initial: Record<string, unknown>) {
  const session = fakeStorageArea(initial);
  vi.stubGlobal('browser', { storage: { session } });
  return session.values;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('space group store', () => {
  it('round-trips its keys and rejects foreign or malformed ones', () => {
    expect(parseSpaceGroupKey(spaceGroupKey('space:with:colons', 7)))
      .toEqual({ spaceId: 'space:with:colons', windowId: 7 });
    expect(parseSpaceGroupKey('hyperActiveSpaceId:v1:7')).toBeUndefined();
    expect(parseSpaceGroupKey('spaceGroupId:x:space')).toBeUndefined();
    expect(parseSpaceGroupKey('spaceGroupId:7:')).toBeUndefined();
  });

  it('keeps each window’s groups apart', async () => {
    const values = installSession({
      [spaceGroupKey('one', 1)]: 10,
      [spaceGroupKey('two', 1)]: 20,
      [spaceGroupKey('one', 2)]: 30,
      [spaceGroupKey('broken', 1)]: 'not a group',
      unrelated: 1,
    });

    expect(await windowSpaceGroups(1)).toEqual(new Map([['one', 10], ['two', 20]]));
    expect(await spaceGroupId('one', 2)).toBe(30);

    await rememberSpaceGroup('three', 1, 40);
    await forgetSpaceGroup('two', 1);
    expect(await windowSpaceGroups(1)).toEqual(new Map([['one', 10], ['three', 40]]));

    await forgetWindowSpaceGroups(1);
    expect(await windowSpaceGroups(1)).toEqual(new Map());
    expect([...values.keys()].sort()).toEqual([spaceGroupKey('broken', 1), spaceGroupKey('one', 2), 'unrelated']);
  });
});
