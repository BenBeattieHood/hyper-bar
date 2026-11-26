# 23. Background Model and Intent Contract

The worker alone owns the model store, and views only render its projection and send intents.
The [model spec](../model/README.md) owns this contract:

- [model §4](../model/04-store-and-transport.md): the `hyper-model-v1` port, client roles and authentication, delivery and acknowledgement, what each role receives, and the build-mismatch notice;
- [model §5](../model/05-controller-inputs.md): every intent kind, its payload, handler and sending surface, and which kinds accept `{items:[...]}`;
- [model §6](../model/06-serialization-causation-and-failures.md): admission, fences, serialisation, causation, status retention and failures.

The rule views most often break, one intent per user choice, is in model §5.
