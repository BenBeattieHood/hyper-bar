# 8. Only a browser start restores a window's tabs

**Decision.** Only `runtime.onStartup` maps restored windows to their previous IDs and reopens each window's space tabs that the browser did not bring back.
When only Hyper restarts (reload, update, re-enable), every window keeps its ID, and a backing in an open window that no open tab claims is removed rather than reopened.
A backing whose window closed while Hyper was off is parked for its space, as it would be had Hyper seen the window close.
[Decision 32](32-a-restored-tab-takes-back-its-own-backing.md) refines this entry with how tabs take back their backings at every start.
The startup chain is in [build-spec §11](../build-spec/11-startup-restoration-and-race-control.md) and parked backings in [§10](../build-spec/10-exact-tab-backing-lifecycle.md).

**Why.** Tab IDs survive an extension reload but tab ownership does not (decision 7), so a tab has to be matched to its backing by what it shows.
Treating an extension reload like a browser start reopened tabs the user had closed, or moved elsewhere, while Hyper was off, which is how duplicate tabs appeared after an update.

**Cost.** Two tabs on the same page may swap backings, so a custom name can move to its twin.
Pairing by site and position can give a tab a backing that was not its own (decision 32).
