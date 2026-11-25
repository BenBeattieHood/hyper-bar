# 36. Production JavaScript is not obfuscated, for now

**Decision.** The production build emits Vite's normal minified JavaScript, and `wxt.config.ts` adds no obfuscation step.

**Why.** Every emitted chunk was obfuscated with `javascript-obfuscator`, which was only a deterrent, not a security boundary.
It slowed builds and made production errors harder to debug, which outweighs that benefit at this stage, so the step was taken out.

**Cost.** The shipped code is as readable as minified JavaScript is.
If distribution makes a deterrent worthwhile, obfuscation can return as a `generateBundle` post-step in `wxt.config.ts` with conservative settings (no control-flow rewriting or global renaming).
