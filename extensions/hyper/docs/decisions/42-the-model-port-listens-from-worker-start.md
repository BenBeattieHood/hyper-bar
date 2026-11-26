# 42. The model port listens from worker start

**Decision.** The background registers its model port listener synchronously as the worker starts, and holds each port's messages until views may authenticate ([model §4](../model/04-store-and-transport.md)).
Held messages then run in the order they arrived, and a port that closed meanwhile is forgotten.

**Why.** Chrome delivers the connection that wakes a stopped worker only to listeners registered while the worker's script first runs.
When the server started only after the first model read, a view's first reconnection after the worker slept was always refused with "Receiving end does not exist".
The client then waited out its backoff, which doubles on each refusal.
A click made while the worker woke took about a second, and under load it could give up after 5000 ms and report that the tab could not be focused.
Accepting the port at once makes the connection that wakes the worker the one that is answered.

**Cost.** A view that connects during startup waits on an open port for the first model read rather than being refused and retrying.
If that read never succeeds, the view stays connecting until the worker stops.
