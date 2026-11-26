# 10. Exact Tab Backing Lifecycle

Every non-pinned, non-incognito, bookmarkable managed tab has exactly one backing.
Exclude extension pages and unsafe internal protocols from durable bookmark backings, while still displaying those live tabs where the browser permits them.

Reconnect in this order:

1. exact persisted backing ID after validating marker, token, space, location, installation, and live claims;
2. unclaimed stable backing token;
3. compatible unclaimed same-window identity;
4. create a new backing and fresh token at its tab's place in the tab strip (§17.2).

Never adopt, move, rename, or delete a backing by URL alone.
Maintain global claimed-ID and claimed-token sets across every live tab.
Duplicate URL tabs require separate IDs and tokens.

On synchronization:

- move the exact backing to the destination space's marked `tabs` tree when ownership changes;
- preserve a marked tab-folder parent while the tab remains in that space;
- update URL and metadata;
- preserve a custom visible title;
- record the exact returned location in tab ownership;
- maintain current-window order through `tabIndex` without globally reordering another window's records.

On individual close, remove only the exact backing.
The backing counts as closing from the moment its tab closes, though its removal waits its turn behind other tab and group mutations.
A restore that runs meanwhile, such as a window showing its space, still finds the backing but never reopens its tab, nor waits for the browser to restore its group ([decision 43](../decisions/43-a-closed-tabs-backing-is-closing-until-released.md)).
If deletion fails, persist its validated exact location in a deduplicated cleanup journal capped at the newest 512 entries.
Retry before cold-start reconciliation and on later lifecycle events.
Never persist a removed native tab ID as cleanup authority.
Remove the journal key when empty.
Multi-step operations have their own journal ([model §6](../model/06-serialization-causation-and-failures.md)).

A backing leaf of this installation is parked when its window ID is absent or names a window that is no longer open.
Window close leaves backings untouched, so a restarted browser can still remap them to its restored windows; it only removes the window's active-space key and group keys.
Only a browser start remaps windows and restores their missing tabs ([§11](11-startup-restoration-and-race-control.md)); after an extension-only restart, a backing in an open window that no live tab claims is removed rather than reopened.
Aggregate failures only after all branches run.
When a start finishes its bootstrap, when a window opens, and one second after a window closes (so a quitting browser does not reopen tabs on its way out), any window whose active space has parked backings adopts and restores them, without opening a blank tab when none are restored.
Otherwise parked backings wait: selecting their space in any window adopts them into that window before restoring its missing tabs.
A live tab of the same space and page claims a parked backing, after same-window matches, before a new backing is created.

How a restarting browser restores its tabs before Hyper reopens any is in [§11](11-startup-restoration-and-race-control.md).
