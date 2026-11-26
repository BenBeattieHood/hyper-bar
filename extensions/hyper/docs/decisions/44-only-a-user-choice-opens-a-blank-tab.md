# 44. Only a user choice opens a blank tab

**Decision.** Hyper opens a blank tab for an empty space only when the user picked that space (`selectSpace`, a new space).
Reopening parked tabs after a window opens or closes (`spaceSwitch.reopenParkedTabs`) runs the switch with `blankTab: false`, so it restores parked tabs and nothing else.
A switch that would open a blank tab also holds back while any tab in the window is still being placed: an unrouted tab, or one dragged in from another window whose ownership still names the window it left (`unplacedTabIds` in `tabs.ts`).

**Why.** A window holding a single tab dragged out of another window must close when that tab closes, as in a stock browser.
Window events fire around a drag out (`windows.onCreated`) and around a close (`windows.onRemoved`), and the reopen they schedule ran a full switch that could open a blank tab in a window whose only tab had not been placed yet.
That tab then outlived the dragged one, so closing the dragged tab left a new tab page and the window stayed open.

**Cost.** A space whose parked backings all turn out to be live already shows nothing new in that window until the user selects it.
