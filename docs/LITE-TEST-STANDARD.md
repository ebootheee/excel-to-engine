# Lite-package test standard (ADR-027)

Every test for the "lite" package (`lib/lite-*.mjs`, `lib/driver-scope.mjs`,
`lib/tier-recommender.mjs`, the evaluator adapters, and the day-in-the-life e2e)
follows the rules below. They exist because Phase 1 shipped a **tautological**
test — one that passed for *any* implementation — and the adversarial review
caught it only after the fact. These rules make that failure mode structurally
hard to repeat.

The shared harness is `tests/lib/_lite-harness.mjs`. New lite tests import it:

```js
import { makeHarness, clone } from './_lite-harness.mjs';
const t = makeHarness('lib/lite-surrogate.mjs');
// ... t.assert / t.near / t.eqArr / t.throws / t.mutationGuard ...
t.done(); // exits non-zero on any failure
```

Existing tests written before the harness (`test-driver-scope`,
`test-tier-recommender`, `test-lite-tier0`) already satisfy the *rules*; they are
grandfathered and need not be rewritten to use the harness.

## The rules

1. **Non-circular truth.** Assert against a value you derived **independently**
   (hand math, a reference OLS, a known closed form) — never a value read back
   from the code under test. If the test's "expected" comes from the same
   function it is checking, it proves nothing.

2. **Negative control.** Include at least one case where a *wrong* impl or a
   *bad* input MUST fail / throw. A test that only ever sees the happy path
   can't distinguish correct from broken.

3. **Mutation guard (mandatory, ≥1 per file).** Use `t.mutationGuard(label, fn)`.
   Inside `fn`: `clone()` the fixture, break it deliberately, feed it to the code
   under test, and assert the code **catches** the break. This proves the test
   would fail against a broken impl. A suite with zero guards prints a WARN.

4. **Provenance is load-bearing — test the refusal.** Any artifact with a
   `modelHash` / `structuralHash` and a refuse-on-mismatch loader MUST have a
   test that tampers with the stamped hash (or the embedded refs) and asserts
   the loader **throws**. Use `t.throws(fn, /stale|tampered|mismatch/, msg)`.

5. **Honesty gates are load-bearing — test the escalation.** Any surrogate /
   tier decision with an output-class r² floor or a kink gate MUST have a test
   that feeds a kinked or below-floor output and asserts it **escalates** (and a
   clean output that does **not**). The synthetic fixture in
   `tests/synthetic-pe-model/engine.js` has a real MIP/pref kink for exactly
   this.

6. **Committed fixtures only; no network; no clock/random.** Tests run in CI
   with no internet and no large gitignored ground-truth. Use the committed
   fixtures (below). Never `JSON.parse` a 100 MB+ file; if you must read one, use
   the streaming reader. `Date.now()`/`Math.random()` are forbidden in
   assertions (they make failures unreproducible).

7. **Run-this-file + wired into `npm test`.** Each test runs standalone
   (`node tests/lib/<file>.mjs`) and is added to the `test` script chain in
   `package.json`. Keep each file fast (< a few seconds) — they run on every
   commit.

## Committed fixtures (the only sanctioned inputs)

| Fixture | What it is | Use it for |
|---|---|---|
| `tests/synthetic-pe-model/engine.js` | recompute-able PE model, grouped output shape, **deliberate MIP@1.5× + pref kink** | evaluator (direct), surrogate fit + **kink escalation**, e2e |
| `tests/cli/fixtures/synthetic-manifest.json` + `synthetic-gt.json` | manifest + ground truth | cascade evaluator (`computeScenario`) |
| `tests/cli/fixtures/cluster-model/chunked/` | chunked engine + GT + graph | engine.run adapter / provenance hash |
| `pipelines/rust/tests/output/chunked/` | parsed synthetic model (engine.js + GT + graph) | engine.run adapter / modelHash |

## The "day in the life" e2e test (Phase 7)

A distinct test type. It simulates *an analyst points a coding agent at this repo
with a model* and asserts the **"wow, that was easy"** path end-to-end on a
committed fixture, with NO Rust and NO network:

- ask the 3 questions → `recommendTier()` picks a tier,
- `selectDrivers()` scopes the levers,
- the chosen emitter (`emitTier0` / surrogate) writes a **KB-sized** artifact,
- the loader **reproduces the base case** within the tier's precision budget,
- `emitIntegrationDoc()` writes a handoff the agent can follow,
- the refuse-on-mismatch loader throws on a tampered artifact.

The assertion of the "wow" is concrete: artifact size, base-case fidelity, and
that the handoff bundle exists and names the right levers/outputs.
