import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { browserCommandActionKinds } from '../entrypoints/lib/browserCommands';
import { hyperActionKinds } from '../entrypoints/lib/modelActions';

/**
 * Executable architecture rules for the model migration in docs/model/.
 *
 * Every budget below is a ratchet, not a ceiling: exceeding it is a regression,
 * and coming in under it fails too, so a fixed violation must be banked here
 * rather than leaving headroom for the next one. Prose in the spec cannot fail;
 * these can, which is the point.
 *
 * It lives here rather than under `entrypoints/` because WXT treats every
 * top-level file in that directory as an extension entrypoint and tries to bundle
 * it.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const readSource = (path: string) => readFileSync(join(repoRoot, path), 'utf8');

const sourceFilesUnder = (path: string): string[] => {
  const absolute = join(repoRoot, path);
  if (!statSync(absolute).isDirectory()) return [path];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) return sourceFilesUnder(child);
    if (!/\.tsx?$/.test(entry.name) || entry.name.includes('.test.')) return [];
    return [child];
  });
};

/** Everything outside the background worker that must not own domain state. */
const viewFiles = [
  ...sourceFilesUnder('entrypoints/sidepanel'),
  ...sourceFilesUnder('entrypoints/newtab'),
  ...sourceFilesUnder('entrypoints/inpage'),
  'entrypoints/page-shortcut.content.ts',
].sort();

const countMatches = (source: string, pattern: RegExp) =>
  (source.match(pattern) ?? []).length;

/**
 * Compares per-file counts against banked budgets in both directions and
 * reports every discrepancy at once, so a sweep does not have to be rerun for
 * each file it touched.
 */
const expectBudgets = (
  actual: ReadonlyMap<string, number>,
  budgets: Readonly<Record<string, number>>,
  advice: string,
) => {
  const problems: string[] = [];
  for (const [file, count] of [...actual].sort()) {
    const budget = budgets[file];
    if (budget === undefined) {
      problems.push(`${file}: ${count} new (no budget). ${advice}`);
    } else if (count > budget) {
      problems.push(`${file}: ${count} exceeds the budget of ${budget}. ${advice}`);
    } else if (count < budget) {
      problems.push(`${file}: ${count} is under the budget of ${budget}. Tighten the budget to ${count}.`);
    }
  }
  for (const file of Object.keys(budgets)) {
    if (!actual.has(file)) problems.push(`${file}: clear. Remove its budget entry.`);
  }
  expect(problems).toEqual([]);
};

const countAcrossViews = (pattern: RegExp) => {
  const counts = new Map<string, number>();
  for (const file of viewFiles) {
    const count = countMatches(readSource(file), pattern);
    if (count > 0) counts.set(file, count);
  }
  return counts;
};

describe('layering', () => {
  // docs/model §1: the model runs in the background. The background
  // importing the view inverts that, and it is why neither side could be tested
  // without loading the other. Now clean, so it is a hard rule.
  it('keeps the background from importing the view', () => {
    const imports = readSource('entrypoints/background.ts')
      .match(/from '\.\/sidepanel\/[^']+'/g) ?? [];
    expect(imports).toEqual([]);
  });

  // §1: "A Jotai store in a React view is prohibited for browser or Hyper
  // domain state." This one is already clean, so it is a hard rule.
  it('keeps jotai out of every view', () => {
    const offenders = viewFiles.filter((file) => /from 'jotai/.test(readSource(file)));
    expect(offenders).toEqual([]);
  });
});

describe('target fence ingress', () => {
  it('records both browser tab move event forms', () => {
    const source = readSource('entrypoints/background.ts');
    expect(source).toMatch(
      /browser\.tabs\.onMoved\.addListener\(\(tabId\) => \{\s+(?:const origin = )?targetLedger\.observe\(tabTarget\(tabId\), 'moved'\);/,
    );
    expect(source).toMatch(
      /browser\.tabs\.onAttached\.addListener\(\(tabId, attachInfo\) => \{\s+targetLedger\.observe\(tabTarget\(tabId\), 'moved'\);/,
    );
  });
});

describe('view browser access', () => {
  // §2: views receive projections and send intents. Every direct call here is
  // a second authority over state the background already owns.
  it('holds the line on direct browser domain calls', () => {
    expectBudgets(
      countAcrossViews(
        /\bbrowser\.(?:tabs|bookmarks|windows|tabGroups|sessions|permissions|scripting|history|search|storage)\b/g,
      ),
      {
        // The two sanctioned self-reads (docs/model §2). A side panel's
        // port sender carries no window, so the sidebar reads its own window id
        // to subscribe a scoped projection, and its own geometry to place itself
        // left or right where no layout query exists. Neither is domain
        // authority the model could supply; both are ratcheted so no third
        // direct read joins them.
        'entrypoints/sidepanel/hooks/useBrowserState.ts': 1,
        'entrypoints/sidepanel/lib/sidebarPlacement.ts': 1,
      },
      'Views read the model projection instead.',
    );
  });

  // §4: "No view listens to browser events or invokes browser APIs for domain
  // state." Each listener here is a race against the background's own read.
  it('holds the line on browser event listeners', () => {
    expectBudgets(
      countAcrossViews(/\bbrowser\.[a-zA-Z]+\??\.on[A-Z][a-zA-Z]*\??\.addListener/g),
      {
        'entrypoints/page-shortcut.content.ts': 1,
        'entrypoints/sidepanel/hooks/useSidebarShortcuts.ts': 1,
      },
      'Observation belongs to the background ingress.',
    );
  });

  // §5: the action inventory is closed. A message that mutates domain state is
  // a path around it.
  it('holds the line on runtime messages', () => {
    expectBudgets(
      countAcrossViews(/\bbrowser\.runtime\??\.sendMessage/g),
      {
        // A content script cannot open a model port, so it asks for its sidebar frame.
        'entrypoints/inpage/host.ts': 1,
        'entrypoints/newtab/App.tsx': 1,
        'entrypoints/page-shortcut.content.ts': 2,
      },
      'Send a typed intent instead.',
    );
  });
});

describe('intent inventory', () => {
  const handlerSources = [
    readSource('entrypoints/lib/bookmarkIntentHandlers.ts'),
    readSource('entrypoints/lib/browserCommandIntentHandlers.ts'),
    readSource('entrypoints/lib/mediaController.ts'),
    readSource('entrypoints/lib/sharedDrag.ts'),
    readSource('entrypoints/lib/spaceIntentHandlers.ts'),
    readSource('entrypoints/lib/splitViewController.ts'),
    readSource('entrypoints/lib/tabContentController.ts'),
    readSource('entrypoints/lib/tabIntentHandlers.ts'),
    readSource('entrypoints/lib/timedMessages.ts'),
    readSource('entrypoints/lib/workspaceIntentHandlers.ts'),
  ];
  // Only a declaration counts; a wiring line such as `closeTabs: (ids) => ...` is not a handler.
  const handled = hyperActionKinds.filter(
    (kind) => handlerSources.some((source) => new RegExp(`^\\s+${kind}: intentHandler\\(`, 'm').test(source)),
  );
  const directCalls = new Set(
    viewFiles.flatMap((file) =>
      [...readSource(file).matchAll(/(?:submitIntent\w*|submitSelection|submitSettledIntent|requireSettledIntent)(?:<[^>]*>)?\(\s*'([a-zA-Z]+)'/g)]
        .map((match) => match[1] ?? ''),
    ),
  );
  const browserCommandCallerFiles = [
    'entrypoints/sidepanel/App.tsx',
    'entrypoints/newtab/App.tsx',
  ];
  const browserCommandActionsAreWired = browserCommandCallerFiles.every(
    (file) => /\bbrowserCommandActions\(\{/.test(readSource(file)),
  );
  const called = new Set([
    ...directCalls,
    ...(browserCommandActionsAreWired ? browserCommandActionKinds : []),
  ]);

  it('keeps command palette browser effects behind explicit model intents', () => {
    expect(browserCommandActionsAreWired).toBe(true);
    expect(browserCommandActionKinds.filter((kind) => !handled.includes(kind))).toEqual([]);
    expect(browserCommandActionKinds.filter((kind) => !hyperActionKinds.includes(kind))).toEqual([]);
    expect(readSource('entrypoints/lib/browserCommands.ts')).not.toMatch(/\bbrowser\./);
  });

  // §5: a handler without a caller is parallel authority waiting to rot.
  it('requires every action handler to have a caller', () => {
    expect(handled.filter((kind) => !called.has(kind))).toEqual([]);
  });

  it('rejects a caller for an action with no handler', () => {
    expect([...called].filter((kind) => !handled.includes(kind as never))).toEqual([]);
  });

  it('rejects an intent kind outside the inventory', () => {
    const inventory: readonly string[] = hyperActionKinds;
    expect([...called].filter((kind) => !inventory.includes(kind))).toEqual([]);
  });

  // Tracks migration progress in the one place that cannot drift from the code.
  // Every declared kind now has a handler and a caller: the inventory carries no
  // inert declarations waiting to rot into parallel authority.
  it('reports handler and caller coverage', () => {
    expect({ callers: called.size, handlers: handled.length, kinds: hyperActionKinds.length })
      .toEqual({ callers: 48, handlers: 48, kinds: 48 });
  });
});

describe('file size', () => {
  // Not a style rule: these three files carry no unit tests and are exactly the
  // ones the migration must change, so growth here is the risk compounding.
  // Shrinking counts as progress only if the budget follows it down, so this
  // fails both ways like every other ratchet.
  it('holds the line on the untested files', () => {
    const counts = new Map(
      [
        'entrypoints/background.ts',
        'entrypoints/sidepanel/App.tsx',
        'entrypoints/sidepanel/hooks/useBrowserState.ts',
      ].map((file) => [file, readSource(file).split('\n').length] as const),
    );
    expectBudgets(counts, {
      'entrypoints/background.ts': 649,
      'entrypoints/sidepanel/App.tsx': 859,
      'entrypoints/sidepanel/hooks/useBrowserState.ts': 586,
    }, 'Move work out of this file rather than raising the budget.');
  });
});

describe('model store writes', () => {
  // §2: listeners schedule reconciliation; they never write the model. Domain
  // state enters the store only through the reconciler's commit, so every
  // browser change and command outcome shares one ordered revision stream.
  it('holds the line on direct model store writes', () => {
    const counts = new Map<string, number>();
    for (const file of sourceFilesUnder('entrypoints')) {
      const count = countMatches(readSource(file), /\b[A-Za-z.]*[sS]tore\??\.set\(/g);
      if (count > 0) counts.set(file, count);
    }
    expectBudgets(counts, {
      // Command bookkeeping, not domain state: admission records a pending
      // command, and a dead client's settled statuses are forgotten.
      'entrypoints/background.ts': 1,
      'entrypoints/lib/modelIntents.ts': 1,
      // The revision-zero seed before the first read.
      'entrypoints/lib/model.ts': 1,
      // The one commit path.
      'entrypoints/lib/modelReconciler.ts': 1,
      // Unit tests' stand-in for the reconciler's commit.
      'entrypoints/lib/testFixtures.ts': 1,
    }, 'Schedule a reconciliation and let the model read the change instead.');
  });
});

describe('view state derivation', () => {
  // §2: the sidebar's domain state is the last projection with pending
  // overlays laid over it. A hand-written field after an intent settles races
  // the next revision, so only `reproject` writes projected state; the other two
  // writes are the loading flag and the view-local busy gauge.
  it('holds the line on sidebar state writes', () => {
    const file = 'entrypoints/sidepanel/hooks/useBrowserState.ts';
    expectBudgets(
      new Map([[file, countMatches(readSource(file), /\bsetState\(/g)]]),
      { [file]: 3 },
      'Derive the field in reproject from the projection instead.',
    );
  });
});
