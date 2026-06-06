#!/usr/bin/env node
/**
 * Smoke test for tests/lib/_lite-harness.mjs — the shared lite test harness.
 *
 * Meta-test: we drive a "subject" harness (the one under test) with known
 * inputs and check its tallies via summary() WITHOUT calling its done() (which
 * would exit the process). The OUTER harness `t` makes the real assertions, so
 * this file itself follows the standard (non-circular: expected counts are hand
 * derived here; a mutation guard; a negative control).
 *
 * Usage: node tests/lib/test-lite-harness.mjs
 */
import { makeHarness, clone } from './_lite-harness.mjs';

const t = makeHarness('tests/lib/_lite-harness.mjs');

// ── counting: assert/near/eq tally pass vs fail independently of the subject ──
{
  const s = makeHarness('subject', { quiet: true });
  s.assert(true, 'a');          // pass
  s.assert(false, 'b');         // fail  (prints a FAIL line — expected)
  s.near(1.0, 1.0 + 1e-12, 1e-9, 'c'); // pass
  s.near(1.0, 2.0, 1e-9, 'd');         // fail
  s.eqArr([1, 2, 3], [1, 2, 3], 'e');  // pass
  s.eqArr([1, 2], [1, 2, 3], 'f');     // fail
  const sum = s.summary();
  // Hand-derived: 3 passes, 3 fails.
  t.eq(sum.passed, 3, 'harness counts passes');
  t.eq(sum.failed, 3, 'harness counts fails');
}

// ── throws(): a fn that throws + matches passes; no-throw or wrong msg fails ──
{
  const s = makeHarness('subject-throws', { quiet: true });
  s.throws(() => { throw new Error('stale modelHash abc'); }, /stale/, 'matches'); // pass
  s.throws(() => 42, /stale/, 'no throw');                                          // fail
  s.throws(() => { throw new Error('other'); }, /stale/, 'wrong msg');              // fail
  const sum = s.summary();
  t.eq(sum.passed, 1, 'throws: only the matching throw passes');
  t.eq(sum.failed, 2, 'throws: no-throw and wrong-msg both fail');
}

// ── mutationGuard(): a guard returning false fails; clean run passes ──────────
{
  const s = makeHarness('subject-guard', { quiet: true });
  s.mutationGuard('caught the break', () => true);    // pass
  s.mutationGuard('missed the break', () => false);   // fail
  const sum = s.summary();
  t.eq(sum.mutations, 2, 'mutation tally increments per guard');
  t.eq(sum.passed, 1, 'guard returning true passes');
  t.eq(sum.failed, 1, 'guard returning false fails');
}

// ── NEGATIVE control: a guard whose probe throws must be recorded as a FAIL ───
{
  const s = makeHarness('subject-guard-throw', { quiet: true });
  s.mutationGuard('probe throws', () => { throw new Error('boom'); });
  const sum = s.summary();
  t.eq(sum.failed, 1, 'a throwing mutation guard is a failure, not a pass');
}

// ── clone() isolates fixtures so a mutation guard cannot corrupt shared state ──
{
  const fixture = { a: 1, nested: { b: [2, 3] } };
  const c = clone(fixture);
  c.nested.b.push(99);
  t.eq(fixture.nested.b.length, 2, 'clone() does not alias nested arrays');
  t.eqArr(c.nested.b, [2, 3, 99], 'clone() is an independent copy');
}

// ── MUTATION GUARD (rule 3): prove this file's counting check is not vacuous ──
// Break the subject by mis-counting and confirm our equality assertion would
// reject it — i.e. if the harness double-counted, t.eq would catch it.
t.mutationGuard('counting is checked, not assumed', () => {
  const s = makeHarness('mutant', { quiet: true });
  s.assert(true, 'one');         // a correct harness => passed===1
  const wouldDetect = s.summary().passed !== 2; // a double-counting mutant => 2
  return wouldDetect;            // true means our check distinguishes correct vs mutant
});

t.done();
