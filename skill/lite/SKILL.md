# excel-to-engine — the Lite front door (`ete lite`)

This is the **right-sizing** skill. When someone has a converted model but does
**not** need the whole engine — they want one or two numbers (carry, IRR, MOIC, a
MIP/threshold bonus, a P&L line) to embed somewhere, ship in a tiny what-if, or
hand to a coding agent — `ete lite` picks the **smallest faithful artifact** and
emits it. No Rust, no internet. The result is a KB-sized file plus a handoff doc.

## Audience: a finance person, not a programmer

The reader may be a PE/VC/RE/IB/corp-dev analyst who is **not** a coder. Default to
plain language: say "the number you actually need," not "the target output key";
say "the levers that move it," not "the scoped drivers." **Do the typing for
them** — run the command, read the result back in their words. Don't make them
learn the flags.

Prerequisite: the model must already be converted (a folder with a
`manifest.json`). If it isn't, convert it first:
`node cli/index.mjs init <model>.xlsx --output ./<name>/` (see `skill/SKILL.md` →
Guided onboarding), then come back here.

## The three questions (the front door)

Ask these three. You answer the hidden 4th by inspection.

1. **What model?** Point me at the converted folder (the one with
   `manifest.json`). That's the `<dir>` below.
2. **What number do you actually need?** Name it: carry, gross or net IRR, MOIC, a
   MIP / threshold bonus, or a P&L line. (One or two is ideal — the smaller the
   ask, the smaller and more faithful the artifact.)
3. **What's the use case?** One of:
   - **one-off** — a single what-if you run once;
   - **dashboard** — a read-only sensitivity view / report;
   - **what-if-grid** — an interactive grid you drive;
   - **embedded-surrogate** — a coefficient surrogate embedded inside another app
     (no Rust at runtime);
   - **app-integration** — embedded in an app (e.g. Mippy) that needs exact
     targeted queries.

### The hidden 4th question (you answer it, not the analyst)

*Can we re-evaluate this model with **no Rust**?* `ete lite` answers it for you by
inspection: it re-samples the model through the **delta-cascade** (which reads
only the manifest + the small ground-truth — no engine, no Rust). It also checks:
does the model have named ranges to map levers? is it cyclic? is it huge? Those
facts decide whether honest no-Rust sampling is even possible. For the common case
(a normal converted model) the answer is yes, and the cascade is the sampler.

## Two personas, two default lanes

- **Analyst** (one-off / dashboard / what-if-grid) → the cheap **no-Rust Tier 0/1
  lane**: a closed-form or a coefficient surrogate, KB-sized, instant.
- **Integrator / embed** (embedded-surrogate / app-integration) → the **Tier 2
  cone** is the *right-sized* artifact: the exact answer over the lever ranges. But
  the cone needs **Rust + a build**, and `ete lite` is the **no-Rust front door** —
  so for an integrator it ships a **disclosed Tier-1 surrogate** *and* tells you,
  in plain language plus an exact command, that the cone is the artifact you really
  want and how to build it (`ete init --emit-cones`). It never silently passes off a
  surrogate as the exact integrator answer.

`ete lite` infers the persona from the use case; you don't pick it. Because it is
no-Rust, `ete lite` never *auto-builds* Tier 2/3 — it only ever **escalates to** them
(with the build command) when the surrogate isn't faithful enough.

## The tier ladder (footprint / fidelity / needs Rust)

| Tier | What it is | Footprint | Fidelity | Needs Rust? |
|---|---|---|---|---|
| **0** | Closed-form | KB / instant | exact for that structure, **calibrated at base** | no |
| **1** | Surrogate (coefficients) | KB / multiplies at runtime | reported r² (~0.9–0.99) | no |
| **2** | Scoped cone | a few MB | 1e-6 over the lever ranges | **yes** (+ ~minutes / ~16 GB build) |
| **3** | Full engine | 100s MB | 1e-6 everywhere | **yes** (to parse; no Rust at runtime once built) |

`ete lite` recommends the **smallest** tier that hits the precision budget for the
number you asked for, then *degrades honestly* when it can't (see Honesty below).

## The exact command

```
ete lite <dir> --output <names> --use-case <one-off|dashboard|what-if-grid|embedded-surrogate|app-integration>
```

Worked example (the common one):

```
ete lite ./my-model/ --output grossIRR,totalCarry --use-case one-off
```

Output names you can ask for: `grossIRR`, `netIRR`, `grossMOIC`, `netMOIC`,
`totalCarry`, `terminalValue`, `exitEquity`, `exitEBITDA`, `price`. Default is
`grossIRR`. The artifact is written to `<dir>/lite-out/` (override with
`--out-dir`); `--no-write` to preview without writing.

## How to read the result

The command prints, in plain language:

- **recommendedTier + rationale** — which artifact it chose and why.
- **Levers** — the inputs that actually move your number (e.g. `exitMultiple`).
- **Artifact path** — a KB-sized file (`lite-surrogate.params.json` or
  `lite-tier0.params.json`) plus a **run file** (`…run.mjs`) you `import run` from.
- **Fidelity per output** — for a surrogate, the r² and the floor it had to clear.
  Each output is labelled with its own class (e.g. `grossIRR (irr)`,
  `totalCarry (carry)`), not just one lumped class.
- **Escalations** — the outputs that need the cone / full engine, and **why**.
- **Disclosures** — the honest caveats for what shipped (e.g. "this carry surrogate
  is below the money-grade floor — treat it as indicative; build the cone for the
  exact number"). Read these before any money decision.

To use the artifact: `import run from "<runFile>"`, then `run({})` for the base
case and `run({ exitMultiple: 16 })` for a what-if. The run file returns **grouped
keys**, so the number you typed as `grossIRR` comes back as `returns.grossIRR`
(the printout tells you the exact key). An **escalated** output comes back as
`{ escalated: true, recommendedTier: 2 }` — never a fabricated number.

## Honesty caveats (say these plainly)

- A **kinked or below-floor money output** — carry sitting near a hurdle, a MIP
  near its threshold — **escalates to the cone** and is **NOT** shipped as a
  confident number. A multiplicative surrogate misprices right at the kink, which
  is exactly where the money decision is made. `ete lite` reports it as escalated
  rather than guessing.
- A surrogate's **r² is fit-to-sample, not fit-to-model.** It measures how well the
  coefficients fit the **no-Rust cascade's** samples — the cascade is itself a
  first-order approximation of the real model. Spot-check against the engine
  (`engine.run()`) where you can before any money decision.
- A Tier-0 closed-form is **calibrated at the base case** — honest at/near base,
  not across a hurdle. `ete lite` will escalate off it when the ask crosses a kink.
- `ete lite` may recommend Tier 0, find that the closed-form doesn't fit this
  model's exact layout, and **fall back to a Tier-1 surrogate with a quoted
  reason**. That degradation is by design — it right-sizes *and* fails honestly.

## Handing it off to a coding agent

`ete lite` writes an **INTEGRATION.md** alongside the artifact. Point the coding
agent at the two files (the `…params.json` artifact + `INTEGRATION.md`). The
handoff names the **levers**, the **per-output fidelity** (r² + floor), and the
**escalated outputs** — so the agent can wire `run()` into an app without reading
any of this tooling's code. For the full engine handoff (when you DO need exact
numbers everywhere), use `<dir>/chunked/INTEGRATION.md` instead.
