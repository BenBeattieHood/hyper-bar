import { describe, expect, it } from 'vitest';
import { decideStructureRepair } from './structureRepair';
import type { StructureHealth } from './modelIntegrity';

const absent: StructureHealth = { status: 'absent' };
const incomplete: StructureHealth = { missing: ['bookmarks'], status: 'incomplete' };
const healthy: StructureHealth = { status: 'healthy' };
const unreadable: StructureHealth = { status: 'unreadable' };
const ambiguous: StructureHealth = {
  duplicates: [{ ids: ['a', 'b'], role: 'hyper' }],
  status: 'ambiguous',
};

describe('decideStructureRepair', () => {
  it.each([
    ['repairs a profile that has never been installed', absent, true],
    ['repairs a tree that is missing a root', incomplete, true],
    ['leaves a healthy tree alone', healthy, false],
    ['does not guess at an ambiguous tree', ambiguous, false],
    ['does not repair what it could not read', unreadable, false],
  ])('%s', (_name, health, repair) => {
    expect(decideStructureRepair(health, undefined).repair).toBe(repair);
  });

  it('does not retry a gap that survived the last attempt', () => {
    const first = decideStructureRepair(incomplete, undefined);
    expect(first.repair).toBe(true);
    expect(decideStructureRepair(incomplete, first.attempted).repair).toBe(false);
  });

  it('attempts a different gap even after one that failed', () => {
    const first = decideStructureRepair(incomplete, undefined);
    expect(decideStructureRepair(absent, first.attempted).repair).toBe(true);
  });

  it('holds the attempt across a tree it cannot judge', () => {
    const first = decideStructureRepair(incomplete, undefined);
    const during = decideStructureRepair(unreadable, first.attempted);
    expect(during.attempted).toBe(first.attempted);
    expect(decideStructureRepair(incomplete, during.attempted).repair).toBe(false);
  });

  it('gives the same gap a fresh attempt once the tree has been healthy', () => {
    const first = decideStructureRepair(incomplete, undefined);
    const recovered = decideStructureRepair(healthy, first.attempted);
    expect(recovered.attempted).toBeUndefined();
    expect(decideStructureRepair(incomplete, recovered.attempted).repair).toBe(true);
  });
});
