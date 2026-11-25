import { describe, expect, it, vi } from 'vitest';
import { itemMenuEntries } from './itemActions';

describe('item menus', () => {
  it('shows an action that cannot be done here disabled, saying why', () => {
    const reload = vi.fn();
    const entries = itemMenuEntries({
      close: { hint: 'Closes it everywhere', label: 'Close tab', run: vi.fn() },
      count: 1,
      copy: vi.fn(),
      paste: vi.fn(),
      pasteUnavailable: 'Nothing can join this session',
      reload: { label: 'Reload', run: reload, unavailable: 'Out of reach' },
    });
    const byId = new Map(entries.map((entry) => [entry.id, entry]));

    expect(byId.get('reload')).toMatchObject({ disabled: true, hint: 'Out of reach' });
    expect(byId.get('paste')).toMatchObject({ disabled: true, hint: 'Nothing can join this session' });
    expect(byId.get('paste')).not.toHaveProperty('isAvailable');
    expect(byId.get('close')).toMatchObject({ hint: 'Closes it everywhere' });
    expect(byId.get('close')).not.toHaveProperty('disabled');
    expect(byId.get('copy')).not.toHaveProperty('disabled');
  });
});
