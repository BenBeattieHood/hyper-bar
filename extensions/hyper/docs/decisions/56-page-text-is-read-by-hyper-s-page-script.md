# 56. Page text is read by Hyper's page script

**Decision.** "Include searching within page text" is a preference, `pageTextSearch`, off by default, saved on the `hyper` root folder like every other preference.
While it is on, `tabContentController.ts` asks each eligible tab's top frame for its text with `tabs.sendMessage`, and Hyper's HTTP(S) content script answers.
The feature asks for no permission, and the `requestPermission` intent and the none/partial/full access state are gone.
Firefox no longer declares optional HTTP(S) origins, since nothing else used them; Chromium keeps the optional `scripting` permission and HTTP(S) origins for "Fix play/pause?" ([§17.3](../build-spec/17-tabs-tab-folders-and-media.md)).

**Why.** The content script that serves Ctrl/Cmd+P and the in-page sidebar matches `http://*/*` and `https://*/*`, so Chromium counts those origins as required.
`permissions.remove` refuses any request that touches a required permission ("You cannot remove required permissions."), so once granted, the optional origins could never be removed.
Turning the switch off therefore always failed with "Page text was cleared, but browser access could not be removed.", and Settings then offered "Remove retained page access", which failed the same way.
The optional access also guarded nothing, because the content script already runs on every HTTP(S) page.

**Cost.** A tab opened before Hyper was installed or reloaded has no content script, so its text is read only after the tab reloads.
A message can arrive before a new page's script listens, so a tab is asked again when its load status changes rather than only on its next navigation.
Users who had turned the feature on must turn it on again, because the old state lived in browser permissions rather than in a preference.
Permissions granted under the old design stay granted until the user removes them in the browser.
