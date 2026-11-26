# 37. A permission is asked for as the click is admitted

**Decision.** An intent whose choice needs a browser permission asks for it in its handler's `admit`, which the background calls while it dispatches the port message that carried the click.
The request is the first browser call there, made before anything is awaited.
What `admit` returns is handed to `run`, and when it is a promise the command joins the effect lane only once that promise settles.
One choice asks this way: the tick of a timed message offered with `gesture`, which is how "Fix play/pause?" asks for one site ([§17.3](../build-spec/17-tabs-tab-folders-and-media.md)).
"Search open page text" in Settings asked this way too until [decision 56](56-page-text-is-read-by-hyper-s-page-script.md) removed its permission.
Whether Hyper can script pages at all is read from the manifest, and after a grant Hyper waits up to a second for `chrome.scripting` to appear before it uses it.
The serialization rules are in [model §06](../model/06-serialization-causation-and-failures.md).

**Why.** Chromium shows a permission prompt only while the user's gesture is live, and in a service worker that lasts only for the synchronous dispatch of the port listener; a request made even one microtask later fails with "This function must be called during a user gesture".
The Settings switch asked from inside the effect lane, after the gesture had gone, so in Chrome and Edge it never showed a prompt and could not be turned on.
Chromium leaves `chrome.scripting` undefined until the optional `scripting` permission is granted, so judging by the API told Hyper that it could never script pages.
After a grant Chromium binds the API into the running worker by another route than the one that answers the request, so the API can briefly trail the grant.
Joining the lane only after the answer keeps the lane free while the prompt is open, and keeps the command's effects from running before the user has answered.

**Cost.** An `admit` must make its request synchronously and must not change the model; an error it throws settles the command as failed through the lane.
Commands admitted while a prompt is open run before the command that opened it.
If the API takes longer than a second to bind, pages Hyper looks at before then are treated as out of reach until it looks at them again.
Firefox declares no `scripting` permission and runs Hyper's page script in pages already open, so it never asks in this way.
