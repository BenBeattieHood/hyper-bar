export interface SessionStorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  remove(keys: string | string[]): Promise<void>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** The extension's session storage, where the browser has it. */
export function sessionStorageArea(): SessionStorageArea | undefined {
  return (browser.storage as unknown as { session?: SessionStorageArea }).session;
}

type NativeSessionValues = Partial<Record<string, (id: number, key: string, value?: unknown) => Promise<unknown>>>;

export interface SessionValueStoreOptions<T> {
  /** Copies each native write to session storage as well, without waiting for it. */
  mirrorWrites?: boolean;
  parse(value: unknown): T | undefined;
  scope: 'Tab' | 'Window';
  storageKey(id: number): string;
  /** The key of the browser's native tab or window value. */
  valueKey: string;
}

/**
 * A value kept for each tab or window until the browser session ends: in the
 * browser's own tab or window values where it has them, else in extension
 * session storage.
 */
export function createSessionValueStore<T>(options: SessionValueStoreOptions<T>) {
  const { parse, scope, storageKey, valueKey } = options;
  const native = () => (browser as unknown as { sessions?: NativeSessionValues }).sessions;

  return {
    async get(id: number): Promise<T | undefined> {
      const value = parse(await native()?.[`get${scope}Value`]?.(id, valueKey).catch(() => undefined));
      if (value !== undefined) return value;
      const key = storageKey(id);
      return parse((await sessionStorageArea()?.get(key).catch(() => undefined))?.[key]);
    },

    /** One storage read for every id the native values do not cover. */
    async getMany(ids: readonly number[]): Promise<Map<number, T>> {
      const sessions = native();
      const nativeValues = sessions?.[`get${scope}Value`]
        ? await Promise.all(ids.map((id) =>
            sessions[`get${scope}Value`]!(id, valueKey).then(parse, () => undefined)))
        : [];
      const unresolvedKeys = ids.flatMap((id, index) => nativeValues[index] ? [] : [storageKey(id)]);
      const stored = unresolvedKeys.length > 0
        ? await sessionStorageArea()?.get(unresolvedKeys).catch(() => undefined) ?? {}
        : {};
      return new Map(ids.flatMap((id, index) => {
        const value = nativeValues[index] ?? parse(stored[storageKey(id)]);
        return value === undefined ? [] : [[id, value] as const];
      }));
    },

    async set(id: number, value: T): Promise<void> {
      const sessions = native();
      const storage = sessionStorageArea();
      if (sessions?.[`set${scope}Value`]) {
        await sessions[`set${scope}Value`]!(id, valueKey, value);
        if (options.mirrorWrites) void storage?.set({ [storageKey(id)]: value }).catch(() => undefined);
      } else if (storage) {
        await storage.set({ [storageKey(id)]: value });
      } else {
        throw new Error(`Per-${scope.toLowerCase()} session storage is unavailable.`);
      }
    },

    /** Clears both places, and rejects with the first failure only once both have settled. */
    async remove(id: number): Promise<void> {
      const sessions = native();
      const storage = sessionStorageArea();
      const removals = await Promise.allSettled([
        ...(sessions?.[`remove${scope}Value`] ? [sessions[`remove${scope}Value`]!(id, valueKey)] : []),
        ...(storage ? [storage.remove(storageKey(id))] : []),
      ]);
      const failure = removals.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) throw failure.reason;
    },
  };
}
