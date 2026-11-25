/**
 * A list kept under one `storage.local` key. Loading and saving keep only
 * entries that parse, the latest entry for each key, then whatever `retain`
 * keeps; an empty list removes the key.
 */
export function createLocalJournal<Entry>(options: {
  keyOf(entry: Entry): string;
  parse(value: unknown): Entry | undefined;
  retain(entries: Entry[]): Entry[];
  storageKey: string;
}) {
  const { keyOf, parse, retain, storageKey } = options;
  const normalise = (value: unknown): Entry[] => {
    if (!Array.isArray(value)) return [];
    const entries = new Map<string, Entry>();
    for (const item of value) {
      const entry = parse(item);
      if (entry === undefined) continue;
      entries.delete(keyOf(entry));
      entries.set(keyOf(entry), entry);
    }
    return retain([...entries.values()]);
  };
  return {
    async load(): Promise<Entry[]> {
      return normalise((await browser.storage.local.get(storageKey))[storageKey]);
    },
    async save(entries: readonly Entry[]): Promise<void> {
      const normalised = normalise(entries);
      if (normalised.length === 0) await browser.storage.local.remove(storageKey);
      else await browser.storage.local.set({ [storageKey]: normalised });
    },
  };
}
