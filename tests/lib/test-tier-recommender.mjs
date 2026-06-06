#!/usr/bin/env node
/**
 * Tests for lib/tier-recommender.mjs — ADR-027 Phase 5 tier recommender.
 *
 * House style (assert/counters/exit code). Pure logic, NO fixtures, NO I/O — runs
 * in-memory in milliseconds (safe to run while a build is in flight).
 *
 * THE PHASE-1 LESSON (encoded here on purpose): the snapshot table below records
 * the EXPECTED tier per scenario INDEPENDENTLY — each `expect` was reasoned from
 * the ADR by hand (§1 personas + §2 ladder + §5 gates), NOT read back from the
 * implementation. So a wrong decision-table change FAILS this test. There is no
 * circular assert (we never compare recommendTier to itself), no `|| true`, and
 * the per-scenario WHY is written from the ADR so a reviewer can re-derive it.
 *
 * Coverage required by the task: includes ≥1 breakpoint-escalation case and ≥1
 * no-Rust case, plus the two-persona defaults and the r²-floor escalation.
 *
 * Mutation-coverage hardening (Phase-5 review findings #1–#8): every contested
 * decision-table branch is now exercised by a row whose `expect` is pinned from the
 * ADR, NOT from the impl — so a wrong edit fails:
 *   - embedded-surrogate + carry/monetary/mip + no kink → Tier 1 UNDER DISCLOSURE (the
 *     ADR §5 by-request carve-out, ratified 2026-06-06 — the ONE floor exemption); the
 *     SAME with a breakpoint → Tier 2 (the kink gate overrides the carve-out).
 *   - what-if-grid + IRR + no breakpoint → Tier 1 (the BASE tier, un-masked by a kink).
 *   - app-integration + IRR + no breakpoint → Tier 2 (the cone is the integrator
 *     DEFAULT, not floor-driven — IRR's 0.97 floor would not escalate).
 *   - a non-boolean breakpoint trait THROWS; an ABSENT one on a kink-prone money
 *     surrogate surfaces a mandatory "BREAKPOINT CHECK NOT RUN" disclosure (kink gate
 *     must not fail open).
 *   - an r²-floor→no-Rust-cap carry surrogate carries a class-specific "BELOW FLOOR"
 *     disclosure, not the generic "cone requested" note.
 *
 * Usage: node tests/lib/test-tier-recommender.mjs
 */

import { recommendTier, R2_FLOORS, USE_CASES } from '../../lib/tier-recommender.mjs';

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); } }

// ─────────────────────────────────────────────────────────────────────────────
// FIXED SNAPSHOT TABLE — expected tier reasoned independently from ADR-027.
//
// Each row: { name, req, expect, expectPersona?, mustEscalate?, why }
//   expect        — the tier a human derives from the ADR for this input
//   mustEscalate  — escalation rule names that MUST appear (the §5 gates that fire)
//   why           — the ADR derivation (so the number isn't a magic constant)
// ─────────────────────────────────────────────────────────────────────────────
const TABLE = [
  // 1. Analyst one-off, carry → base Tier 0, no kink, Rust present. §2: a single
  //    what-if is the closed-form's home; carry's 0.99 floor does NOT escalate
  //    Tier 0 (the floor gate only bites Tier-1 surrogates). EXPECT 0.
  {
    name: 'analyst one-off carry, no kink',
    req: { useCase: 'one-off', targetOutputs: { class: 'carry' }, modelTraits: { hasBreakpointInRange: false, rustAvailable: true } },
    expect: 0, expectPersona: 'analyst', mustEscalate: [],
    why: 'ADR §1 one-off=analyst; §2 single what-if → Tier 0 closed-form; carry floor does not pull Tier 0 up.',
  },

  // 2. Analyst dashboard, IRR → base Tier 1 surrogate (a sensitivity VIEW needs
  //    the response shape across a range). IRR floor 0.97 (< 0.99) so the r²-floor
  //    gate does NOT fire; no kink. EXPECT 1.
  {
    name: 'analyst dashboard IRR, no kink',
    req: { useCase: 'dashboard', targetOutputs: { class: 'irr' }, modelTraits: { hasBreakpointInRange: false, rustAvailable: true } },
    expect: 1, expectPersona: 'analyst', mustEscalate: [],
    why: 'ADR §2 dashboard view → Tier 1 surrogate; IRR floor 0.97 < 0.99 so no r²-floor escalation.',
  },

  // 3. Analyst dashboard, CARRY → base Tier 1, but carry floor is 0.99 → the §5
  //    r²-floor gate escalates a (non-surrogate-request) Tier 1 to Tier 2. EXPECT 2.
  {
    name: 'analyst dashboard CARRY (0.99 floor) → r2-floor escalation',
    req: { useCase: 'dashboard', targetOutputs: { class: 'carry' }, modelTraits: { hasBreakpointInRange: false, rustAvailable: true } },
    expect: 2, expectPersona: 'analyst', mustEscalate: ['r2-floor'],
    why: 'ADR §5 monetary/carry r² floor 0.99 — a base-case surrogate is not trustworthy enough → Tier 2 cone.',
  },

  // 4. Analyst what-if-grid, MOIC, breakpoint in range → KINK GATE forces Tier 2
  //    regardless of persona (§5). MOIC floor 0.97 wouldn't escalate on its own;
  //    the breakpoint does. EXPECT 2 with kink-gate.
  {
    name: 'analyst what-if-grid MOIC with breakpoint → kink gate',
    req: { useCase: 'what-if-grid', targetOutputs: { class: 'moic' }, modelTraits: { hasBreakpointInRange: true, rustAvailable: true } },
    expect: 2, expectPersona: 'analyst', mustEscalate: ['kink-gate'],
    why: 'ADR §5 kink gate: a detected breakpoint forces Tier 2 (surrogate misprices near the hurdle), any persona.',
  },

  // 5. Integrator app-integration, carry → base Tier 2 cone (the integrator
  //    default, §1). Rust present, no kink. EXPECT 2, no escalation (it STARTS at 2).
  {
    name: 'integrator app-integration carry → cone default',
    req: { useCase: 'app-integration', targetOutputs: { class: 'carry' }, modelTraits: { hasBreakpointInRange: false, rustAvailable: true } },
    expect: 2, expectPersona: 'integrator', mustEscalate: [],
    why: 'ADR §1 integrator default = Tier 2 cone; it starts at 2 so no escalation needed.',
  },

  // 5b. Analyst what-if-grid, IRR (0.97 floor), NO breakpoint, Rust present →
  //     base Tier 1 surrogate stands. This independently pins the what-if-grid BASE
  //     tier (1) without it being masked by the kink gate — finding #4 (row 4 sets a
  //     breakpoint, so the base was previously untested). IRR floor 0.97 < 0.99 so
  //     no r²-floor escalation. EXPECT 1, no escalation.
  {
    name: 'analyst what-if-grid IRR, no breakpoint → base Tier 1 (kink-gate not masking)',
    req: { useCase: 'what-if-grid', targetOutputs: { class: 'irr' }, modelTraits: { hasBreakpointInRange: false, rustAvailable: true } },
    expect: 1, expectPersona: 'analyst', mustEscalate: [],
    why: 'ADR §2 what-if-grid → cheap no-Rust surrogate (Tier 1); IRR floor 0.97 < 0.99 and no kink so the base stands unescalated.',
  },

  // 5c. Integrator app-integration, IRR (0.97 floor), NO breakpoint, Rust present →
  //     base Tier 2 cone is the integrator DEFAULT, NOT a floor-driven escalation
  //     (IRR's 0.97 floor would not pull a surrogate to the cone). This makes the
  //     cone-default tier assertion load-bearing rather than coincidental with
  //     carry's 0.99 r²-floor — finding #5. EXPECT 2, no escalation (starts at 2).
  {
    name: 'integrator app-integration IRR, no breakpoint → cone is the DEFAULT (not floor-driven)',
    req: { useCase: 'app-integration', targetOutputs: { class: 'irr' }, modelTraits: { hasBreakpointInRange: false, rustAvailable: true } },
    expect: 2, expectPersona: 'integrator', mustEscalate: [],
    why: 'ADR §1 integrator default = Tier 2 cone; IRR floor 0.97 would NOT escalate a surrogate, so tier=2 must be the base default, not the r²-floor.',
  },

  // 6. Integrator embedded-surrogate, IRR, no kink → Tier 1 BY REQUEST. The user
  //    explicitly asked for a surrogate and IRR's 0.97 floor is BELOW the 0.99
  //    r²-floor gate, so the gate does not bite and the request stands. EXPECT 1.
  {
    name: 'integrator embedded-surrogate IRR (explicit surrogate request, 0.97 floor)',
    req: { useCase: 'embedded-surrogate', targetOutputs: { class: 'irr' }, modelTraits: { hasBreakpointInRange: false, rustAvailable: true } },
    expect: 1, expectPersona: 'integrator', mustEscalate: [],
    why: 'ADR §2 embedded-surrogate base Tier 1; IRR floor 0.97 < 0.99 so the r²-floor gate does not fire — the request stands.',
  },

  // 6b. Integrator embedded-surrogate, CARRY (0.99 floor), no kink, Rust present →
  //     the ADR §5 BY-REQUEST CARVE-OUT (ratified 2026-06-06) keeps it at Tier 1
  //     UNDER DISCLOSURE: the integrator explicitly asked for a surrogate to embed and
  //     knowingly accepts the 0.99-floor risk. This is the ONE floor exemption (NOT
  //     "surrogate everywhere") — it fires only on an explicit request, so it is a
  //     disclosure, not a tier escalation. EXPECT 1, no escalation. (Row 7 shows a
  //     kink still overrides it.) The by-request disclosure itself is asserted below.
  {
    name: 'embedded-surrogate CARRY no kink → Tier 1 by-request carve-out (under disclosure)',
    req: { useCase: 'embedded-surrogate', targetOutputs: { class: 'carry' }, modelTraits: { hasBreakpointInRange: false, rustAvailable: true } },
    expect: 1, expectPersona: 'integrator', mustEscalate: [],
    why: 'ADR §5 by-request carve-out: an explicit embedded-surrogate request keeps a 0.99-class at Tier 1 under disclosure; no escalation (the kink gate would still override — see row 7).',
  },

  // 7. Integrator embedded-surrogate, CARRY, but breakpoint in range → even an
  //    explicit surrogate request CANNOT survive a kink (§5 kink gate is
  //    non-suppressible). EXPECT 2.
  {
    name: 'integrator embedded-surrogate CARRY with breakpoint → kink overrides request',
    req: { useCase: 'embedded-surrogate', targetOutputs: { class: 'carry' }, modelTraits: { hasBreakpointInRange: true, rustAvailable: true } },
    expect: 2, expectPersona: 'integrator', mustEscalate: ['kink-gate'],
    why: 'ADR §5 kink gate is mandatory & non-suppressible — beats the explicit surrogate request.',
  },

  // 8. NO-RUST case: integrator app-integration carry (would be Tier 2 cone) but
  //    rustAvailable=false → the cone is unreachable; ADR Consequences fall back to
  //    a disclosed surrogate. Sampling feasible (named ranges present, not cyclic,
  //    small). EXPECT 1 with no-rust-cap.
  {
    name: 'no-Rust: cone-default app-integration falls back to disclosed surrogate',
    req: { useCase: 'app-integration', targetOutputs: { class: 'carry' }, modelTraits: { rustAvailable: false, hasNamedRanges: true, cyclic: false, sizeCells: 50000, hasBreakpointInRange: false } },
    expect: 1, expectPersona: 'integrator', mustEscalate: ['no-rust-cap'],
    why: 'ADR Consequences: cone gated/unavailable without Rust → integrator default falls back to a disclosed Tier 1 surrogate.',
  },

  // 9. NO-RUST + kink: app-integration carry, breakpoint in range, no Rust. Kink
  //    forces Tier 2, but no-Rust caps it back to Tier 1 (sampling feasible) with
  //    BOTH a kink-gate AND a no-rust-cap escalation (the unresolved-kink
  //    disclosure must surface). EXPECT 1, both rules present.
  {
    name: 'no-Rust + breakpoint: kink wants cone, no-Rust caps to surrogate (unresolved kink)',
    req: { useCase: 'app-integration', targetOutputs: { class: 'carry' }, modelTraits: { rustAvailable: false, hasNamedRanges: true, cyclic: false, sizeCells: 50000, hasBreakpointInRange: true } },
    expect: 1, expectPersona: 'integrator', mustEscalate: ['kink-gate', 'no-rust-cap'],
    why: 'Kink forces Tier 2 (§5), no-Rust caps to Tier 1 (Consequences) — both fire; the unresolved-kink risk is disclosed.',
  },

  // 10. NO-RUST + infeasible sampling: dashboard IRR (base Tier 1), no Rust, AND
  //     cyclic model → the cascade can't sweep → drop to Tier 0. EXPECT 0 with
  //     sampling-infeasible-cap.
  {
    name: 'no-Rust + cyclic: surrogate sampling infeasible → Tier 0',
    req: { useCase: 'dashboard', targetOutputs: { class: 'irr' }, modelTraits: { rustAvailable: false, cyclic: true, hasNamedRanges: true, sizeCells: 50000, hasBreakpointInRange: false } },
    expect: 0, expectPersona: 'analyst', mustEscalate: ['sampling-infeasible-cap'],
    why: 'ADR load-bearing finding: no-Rust sweep needs the cascade; cyclic model breaks it → drop to Tier 0 closed-form.',
  },

  // 11. NO-RUST + no named ranges on a cone-default integration → cone unreachable
  //     AND surrogate sampling infeasible (can\'t map levers) → Tier 0. Both
  //     no-rust-cap (2→0 directly, sampling not ok) fires. EXPECT 0.
  {
    name: 'no-Rust + no named ranges: cone-default drops straight to Tier 0',
    req: { useCase: 'app-integration', targetOutputs: { class: 'monetary' }, modelTraits: { rustAvailable: false, hasNamedRanges: false, cyclic: false, sizeCells: 50000, hasBreakpointInRange: false } },
    expect: 0, expectPersona: 'integrator', mustEscalate: ['no-rust-cap'],
    why: 'No Rust → cone unreachable; no named ranges → cascade can\'t map levers → no-rust-cap drops to Tier 0 (not 1).',
  },

  // 12. Analyst one-off PnL with a breakpoint → even a one-off (base Tier 0) is
  //     escalated by the kink gate to Tier 2 (a breakpoint means the closed form
  //     mis-prices). EXPECT 2 with kink-gate. (Shows the kink gate reaches Tier 0.)
  {
    name: 'analyst one-off PnL with breakpoint → kink escalates Tier 0 to cone',
    req: { useCase: 'one-off', targetOutputs: { class: 'pnl' }, modelTraits: { hasBreakpointInRange: true, rustAvailable: true } },
    expect: 2, expectPersona: 'analyst', mustEscalate: ['kink-gate'],
    why: 'ADR §5 kink gate fires from any base tier < 2 — a one-off across a breakpoint must use the cone.',
  },

  // 13. Huge model, no Rust, embedded-surrogate IRR → sampling infeasible (huge) +
  //     no Rust → can't honor the surrogate → Tier 0. EXPECT 0.
  {
    name: 'no-Rust + huge model: embedded-surrogate cannot sample → Tier 0',
    req: { useCase: 'embedded-surrogate', targetOutputs: { class: 'irr' }, modelTraits: { rustAvailable: false, hasNamedRanges: true, cyclic: false, sizeCells: 5_800_000, hasBreakpointInRange: false } },
    expect: 0, expectPersona: 'integrator', mustEscalate: ['sampling-infeasible-cap'],
    why: 'ADR: huge models make no-Rust cascade sampling impractical; with no Rust to sweep, Tier 1 can\'t be honored → Tier 0.',
  },
];

// ── Run the snapshot table ───────────────────────────────────────────────────
console.log('Testing: tier-recommender snapshot table (expected tier reasoned from ADR-027)');
for (const row of TABLE) {
  const r = recommendTier(row.req);
  assert(r.tier === row.expect, `${row.name}: tier === ${row.expect} (got ${r.tier}). ${row.why}`);
  if (row.expectPersona) {
    assert(r.persona === row.expectPersona, `${row.name}: persona === ${row.expectPersona} (got ${r.persona})`);
  }
  const firedRules = r.escalations.map((e) => e.rule);
  for (const rule of row.mustEscalate) {
    assert(firedRules.includes(rule), `${row.name}: escalation '${rule}' MUST fire (fired: [${firedRules.join(', ')}])`);
  }
  // If the table says no escalation, assert none fired (catches spurious upgrades).
  if (row.mustEscalate.length === 0) {
    assert(r.escalations.length === 0, `${row.name}: NO escalation expected (fired: [${firedRules.join(', ')}])`);
  }
  // Every escalation must be flagged mandatory (ADR §5: not silently skippable).
  for (const e of r.escalations) {
    assert(e.mandatory === true, `${row.name}: escalation '${e.rule}' is flagged mandatory (ADR §5 non-skippable)`);
  }
  // Precision budget always reports the governing r² floor for the output class.
  assert(typeof r.precisionBudget.r2Floor === 'number', `${row.name}: precisionBudget.r2Floor is a number`);
}

// ── Independent structural assertions (not snapshot rows) ─────────────────────

// r² floors match the ADR §5 numbers EXACTLY (independent of the table above).
console.log('Testing: output-class r² floors match ADR §5 (0.99 monetary/carry, 0.97 IRR/MOIC)');
assert(R2_FLOORS.monetary === 0.99, 'monetary r² floor = 0.99 (ADR §5)');
assert(R2_FLOORS.carry === 0.99, 'carry r² floor = 0.99 (ADR §5)');
assert(R2_FLOORS.irr === 0.97, 'IRR r² floor = 0.97 (ADR §5)');
assert(R2_FLOORS.moic === 0.97, 'MOIC r² floor = 0.97 (ADR §5)');

// The governing class is the TIGHTEST when multiple outputs are requested.
console.log('Testing: multiple target outputs → tightest r² floor governs');
{
  const r = recommendTier({ useCase: 'dashboard', targetOutputs: { class: ['irr', 'carry'] }, modelTraits: { rustAvailable: true, hasBreakpointInRange: false } });
  assert(r.precisionBudget.outputClass === 'carry', 'mixed [irr,carry] → governing class is carry (tightest floor)');
  assert(r.precisionBudget.r2Floor === 0.99, 'mixed [irr,carry] → r² floor 0.99');
  assert(r.tier === 2, 'mixed [irr,carry] dashboard → r²-floor gate escalates to Tier 2');
}

// An r² floor below the requested budget is itself an escalation off Tier 1: the
// monetary class (0.99) on a dashboard must NOT remain a plain Tier 1.
console.log('Testing: monetary dashboard cannot remain a plain Tier 1 surrogate');
{
  const r = recommendTier({ useCase: 'dashboard', targetOutputs: { class: 'monetary' }, modelTraits: { rustAvailable: true, hasBreakpointInRange: false } });
  assert(r.tier !== 1, `monetary dashboard escalated off plain Tier 1 (got ${r.tier})`);
  assert(r.escalations.some((e) => e.rule === 'r2-floor'), 'monetary dashboard fires the r2-floor gate');
}

// Unknown use case throws (input-domain contract).
console.log('Testing: unknown useCase throws (input-domain contract)');
{
  let threw = false;
  try { recommendTier({ useCase: 'bogus' }); } catch (e) { threw = /unknown useCase/i.test(e.message); }
  assert(threw, 'recommendTier throws on an unknown useCase');
}

// Purity: same inputs → identical output (snapshot-safe, no Date/random).
console.log('Testing: recommendTier is pure (same input → identical output)');
{
  const req = { useCase: 'app-integration', targetOutputs: { class: 'carry' }, modelTraits: { rustAvailable: true, hasBreakpointInRange: false } };
  const a = JSON.stringify(recommendTier(req));
  const b = JSON.stringify(recommendTier(req));
  assert(a === b, 'two calls with the same input produce byte-identical results (pure)');
}

// Defensive: every USE_CASE produces a valid tier (no enum gap).
console.log('Testing: every USE_CASE yields a tier in {0,1,2,3}');
for (const uc of USE_CASES) {
  const r = recommendTier({ useCase: uc, targetOutputs: { class: 'irr' }, modelTraits: { rustAvailable: true, hasBreakpointInRange: false } });
  assert([0, 1, 2, 3].includes(r.tier), `useCase '${uc}' yields a valid tier (got ${r.tier})`);
}

// Finding #1/#2/#3 + the ADR §5 BY-REQUEST CARVE-OUT (ratified 2026-06-06). The
// r²-floor gate keeps a 0.99-floor output (monetary/carry/mip) from shipping as a
// plain Tier-1 SURROGATE — EXCEPT for an explicit embedded-surrogate request, which
// MAY ship Tier 1 UNDER DISCLOSURE (the ONE exemption; NOT "surrogate everywhere").
// So with no kink + Rust present: every NON-embedded-surrogate use case must NEVER
// end at Tier 1 for a 0.99-class (it's Tier 0 for one-off — closed-form exact at base
// — or Tier 2 cone otherwise); embedded-surrogate MUST stay Tier 1 with a by-request
// below-floor disclosure. This pins BOTH directions: dropping the carve-out flips
// embedded-surrogate to Tier 2 and FAILS; widening it to another use case flips that
// one to Tier 1 and FAILS.
console.log('Testing: r²-floor gate + the ADR §5 by-request carve-out (embedded-surrogate only)');
for (const uc of USE_CASES) {
  for (const cls of ['monetary', 'carry', 'mip']) {
    const r = recommendTier({ useCase: uc, targetOutputs: { class: cls }, modelTraits: { rustAvailable: true, hasBreakpointInRange: false } });
    if (uc === 'embedded-surrogate') {
      assert(r.tier === 1, `embedded-surrogate/${cls}: by-request carve-out keeps Tier 1 (got ${r.tier})`);
      assert(!r.escalations.some((e) => e.rule === 'r2-floor'), `embedded-surrogate/${cls}: r2-floor does NOT escalate an explicit by-request surrogate`);
      assert(r.precisionBudget.disclosures.some((d) => /BY-REQUEST SURROGATE BELOW FLOOR/.test(d)), `embedded-surrogate/${cls}: ships under the by-request below-floor disclosure`);
    } else {
      assert(r.tier !== 1, `${uc}/${cls}: 0.99-floor output must NOT ship as a plain Tier-1 surrogate (got ${r.tier})`);
      // dashboard/what-if-grid have BASE tier 1, so the r²-floor gate is what moves
      // them off Tier 1 — assert it fired. one-off (base 0) and app-integration
      // (base 2) never sit at Tier 1, so the gate has nothing to do there.
      if (['dashboard', 'what-if-grid'].includes(uc)) {
        assert(r.escalations.some((e) => e.rule === 'r2-floor'), `${uc}/${cls}: r2-floor gate fires (non-surrogate-request)`);
      }
    }
  }
}

// Finding #7 — the kink gate must NOT fail open. A non-boolean hasBreakpointInRange
// (a wiring mistake passing a count or the breakpoints array) THROWS rather than
// silently treating it as "no breakpoint".
console.log('Testing: kink gate does not fail open — non-boolean hasBreakpointInRange throws');
{
  for (const bad of [1, 0, [1, 2], 'true', {}]) {
    let threw = false;
    try {
      recommendTier({ useCase: 'embedded-surrogate', targetOutputs: { class: 'carry' }, modelTraits: { rustAvailable: true, hasBreakpointInRange: bad } });
    } catch (e) { threw = /hasBreakpointInRange must be a boolean/i.test(e.message); }
    assert(threw, `non-boolean hasBreakpointInRange (${JSON.stringify(bad)}) throws — kink gate cannot fail open`);
  }
}

// Finding #7 — an ABSENT breakpoint signal for a kink-prone money class that could
// ship a surrogate/closed-form (Tier 0/1) is unsafe-by-default: a mandatory
// "BREAKPOINT CHECK NOT RUN" disclosure must surface so the unverified kink risk is
// visible. Use a no-Rust embedded-surrogate carry (drops to Tier 1) with the
// breakpoint trait OMITTED.
console.log('Testing: absent breakpoint signal on kink-prone money → mandatory "check not run" disclosure');
{
  const r = recommendTier({ useCase: 'embedded-surrogate', targetOutputs: { class: 'carry' }, modelTraits: { rustAvailable: false, hasNamedRanges: true, cyclic: false, sizeCells: 50000 } });
  assert(r.tier <= 1, `no-Rust carry surrogate drops to Tier ≤1 (got ${r.tier})`);
  assert(
    r.precisionBudget.disclosures.some((d) => /BREAKPOINT CHECK NOT RUN/.test(d)),
    'absent breakpoint signal on a shipped carry surrogate surfaces the "BREAKPOINT CHECK NOT RUN" disclosure',
  );
}
// Conversely, when the breakpoint signal IS supplied (false), that disclosure must
// NOT appear (no false alarm).
{
  const r = recommendTier({ useCase: 'embedded-surrogate', targetOutputs: { class: 'carry' }, modelTraits: { rustAvailable: false, hasNamedRanges: true, cyclic: false, sizeCells: 50000, hasBreakpointInRange: false } });
  assert(
    !r.precisionBudget.disclosures.some((d) => /BREAKPOINT CHECK NOT RUN/.test(d)),
    'with the breakpoint signal supplied (false), the "check not run" disclosure is suppressed (no false alarm)',
  );
}

// Finding #8 — when the r²-floor forces ≥Tier 2 and the no-Rust cap then drops a
// carry/monetary/mip output back to a surrogate, the disclosure must carry the
// CLASS-SPECIFIC "below floor" reason (not the generic "cone requested" note) and
// must NOT falsely claim the cone was "requested". Dashboard carry, no Rust,
// sampling feasible, breakpoint=false (so the kink path is NOT the reason).
console.log('Testing: no-Rust cap after r²-floor → class-specific "below floor" disclosure (not "requested")');
{
  const r = recommendTier({ useCase: 'dashboard', targetOutputs: { class: 'carry' }, modelTraits: { rustAvailable: false, hasNamedRanges: true, cyclic: false, sizeCells: 50000, hasBreakpointInRange: false } });
  assert(r.tier === 1, `r²-floor forces cone then no-Rust caps to Tier 1 (got ${r.tier})`);
  const rules = r.escalations.map((e) => e.rule);
  assert(rules.includes('r2-floor') && rules.includes('no-rust-cap'), `both r2-floor and no-rust-cap fire (got [${rules.join(', ')}])`);
  assert(
    r.precisionBudget.disclosures.some((d) => /CARRY SURROGATE BELOW FLOOR/.test(d)),
    'the no-Rust fallback carries the class-specific "CARRY SURROGATE BELOW FLOOR" reason',
  );
  assert(
    !r.precisionBudget.disclosures.some((d) => /the exact cone was requested/i.test(d)),
    'the no-Rust fallback does NOT falsely claim the cone was "requested" when the r²-floor forced it',
  );
}
// And the genuine cone-DEFAULT no-Rust fallback (app-integration IRR, where the
// cone is the integrator default, NOT floor-driven) keeps the plain fallback note.
{
  const r = recommendTier({ useCase: 'app-integration', targetOutputs: { class: 'irr' }, modelTraits: { rustAvailable: false, hasNamedRanges: true, cyclic: false, sizeCells: 50000, hasBreakpointInRange: false } });
  assert(r.tier === 1, `cone-default IRR app-integration caps to Tier 1 under no-Rust (got ${r.tier})`);
  assert(
    r.precisionBudget.disclosures.some((d) => /NO-RUST FALLBACK/.test(d) && /integrator default/.test(d)),
    'the genuine cone-default fallback keeps the plain "integrator default" no-Rust note',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);
