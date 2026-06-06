/**
 * _lite-harness.mjs — shared test harness for the ADR-027 "lite" package suite.
 *
 * The lite phases (Tier-0 / driver-scope / tier-recommender / evaluators /
 * surrogate / provenance / e2e) all follow the same house style: a counted
 * assert, a non-circular truth, a NEGATIVE control, an explicit MUTATION guard,
 * and a hard process.exit(1) on any failure so `npm test` fails loudly. This
 * file factors that style out so new lite tests don't re-implement it (and so
 * the convention can't quietly drift between phases).
 *
 * Rules every lite test MUST follow (see docs/LITE-TEST-STANDARD.md):
 *   1. Assert against an INDEPENDENTLY derived truth, never a value read back
 *      from the code under test (that is the tautology trap Phase 1 shipped).
 *   2. Include at least one NEGATIVE control (a wrong impl/input MUST fail).
 *   3. Include at least one MUTATION guard — call mutationGuard() to prove the
 *      test actually fails when the behaviour it claims to cover is broken.
 *   4. No network, no clock/random dependence, committed fixtures only.
 *   5. End with harness.done() (exits non-zero on any failure).
 *
 * Usage:
 *   import { makeHarness } from './_lite-harness.mjs';
 *   const t = makeHarness('lib/lite-surrogate.mjs');
 *   t.assert(cond, 'msg');
 *   t.near(a, b, 1e-9, 'msg');
 *   t.throws(() => load(bad), /stale/, 'refuses on mismatch');
 *   t.mutationGuard('floor gate', () => assertGateRejects(brokenParams));
 *   t.done();
 *
 * @license MIT
 */

/**
 * Create a harness instance bound to a label (the module under test).
 * @param {string} [label]
 * @returns {object} harness with assert/eq/eqArr/near/ok/throws/section/
 *                   mutationGuard/summary/done and live passed/failed counts.
 */
export function makeHarness(label = '', opts = {}) {
  const quiet = opts.quiet === true; // silence per-fail lines (meta-tests only)
  const state = { passed: 0, failed: 0, mutations: 0, sections: [] };

  function pass() { state.passed++; }
  function fail(msg) { state.failed++; if (!quiet) console.error(`  FAIL: ${msg}`); }

  function assert(cond, msg) {
    if (cond) pass();
    else fail(msg);
    return !!cond;
  }

  /** strict deep-ish equality for scalars / arrays / plain objects. */
  function eq(a, b, msg) {
    return assert(deepEq(a, b), `${msg} (got ${fmt(a)}, want ${fmt(b)})`);
  }

  function eqArr(a, b, msg) {
    const ok =
      Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((v, i) => deepEq(v, b[i]));
    return assert(ok, `${msg} (got ${fmt(a)}, want ${fmt(b)})`);
  }

  function near(a, b, tol, msg) {
    return assert(
      typeof a === 'number' && Number.isFinite(a) && Math.abs(a - b) <= tol,
      `${msg} (got ${fmt(a)}, want ~${fmt(b)} +/-${tol})`,
    );
  }

  const ok = assert;

  /**
   * Assert that `fn` throws, optionally matching `re` against the message.
   * A function that does NOT throw fails (this is how we test the
   * refuse-on-mismatch loaders — the whole point is that they throw).
   */
  function throws(fn, re, msg) {
    let threw = null;
    try { fn(); } catch (e) { threw = e; }
    if (!threw) return assert(false, `${msg} (expected throw, none)`);
    if (re && !re.test(threw.message)) {
      return assert(false, `${msg} (threw "${threw.message}", want match ${re})`);
    }
    return pass(), true;
  }

  function section(name) { state.sections.push(name); }

  /**
   * MUTATION GUARD — the anti-tautology check. Run `breakAndProbe`, which must
   * itself perform an assertion that PASSES only because the behaviour-under-
   * test correctly REJECTS a deliberately broken input/impl. If `breakAndProbe`
   * throws OR fails its inner assert, the guard fails — meaning the real test
   * would pass even against a broken impl (a tautology). Counts toward a
   * dedicated `mutations` tally so a suite with zero guards is visible.
   *
   * Convention: inside breakAndProbe, mutate a copy (never the real fixture),
   * feed it to the code under test, and assert the code catches it.
   *
   * @param {string} label  what behaviour this guard protects
   * @param {() => boolean|void} breakAndProbe  returns falsy / throws on guard failure
   */
  function mutationGuard(label, breakAndProbe) {
    state.mutations++;
    let result, err = null;
    try { result = breakAndProbe(); } catch (e) { err = e; }
    if (err) return assert(false, `mutation-guard "${label}" threw: ${err.message}`);
    // A guard that returns an explicit `false` failed; `undefined` (no return)
    // is treated as success only if it ran clean — encourage returning the bool.
    if (result === false) return assert(false, `mutation-guard "${label}" did not catch the break`);
    return pass(), true;
  }

  function summary() {
    return { label, ...state };
  }

  function done() {
    const tag = label ? `[${label}] ` : '';
    if (state.mutations === 0) {
      // Not fatal, but loud: the standard REQUIRES >=1 mutation guard.
      console.error(`  WARN: ${tag}no mutation guards — see docs/LITE-TEST-STANDARD.md rule 3`);
    }
    const line =
      `${tag}${state.passed} passed, ${state.failed} failed` +
      ` (${state.mutations} mutation guard${state.mutations === 1 ? '' : 's'})`;
    if (state.failed > 0) {
      console.error(`\n✗ ${line}`);
      process.exit(1);
    }
    console.log(`\n✓ ${line}`);
  }

  return {
    assert, ok, eq, eqArr, near, throws, section, mutationGuard, summary, done,
    get passed() { return state.passed; },
    get failed() { return state.failed; },
    get mutations() { return state.mutations; },
  };
}

// ── small internal helpers (no deps) ─────────────────────────────────────────

function deepEq(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    return a === b || (Number.isNaN(a) && Number.isNaN(b));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEq(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEq(a[k], b[k]));
  }
  return false;
}

function fmt(v) {
  if (Array.isArray(v)) return `[${v.map(fmt).join(',')}]`;
  if (v && typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'number' && !Number.isInteger(v)) return v.toPrecision(6);
  return String(v);
}

/**
 * deepClone a JSON-safe fixture so a mutation guard never corrupts the shared
 * committed fixture for later assertions in the same file.
 */
export function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}
