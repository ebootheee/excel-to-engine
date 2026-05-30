# Usability scoring rubric

Used by the simulated-journey workflow. Two stages per persona: the **analyst
journey** (a non-/semi-technical finance user, via an AI assistant, converts their
model and prepares a handoff) and the **coding-agent handoff** (a developer agent,
given only the output folder, builds a working integration). Score each dimension
0–5. Capture concrete stumbles, not just numbers.

## Stage 1 — Analyst journey (the "walk me through it" half)

| # | Dimension | 0 | 5 |
|---|-----------|---|---|
| A1 | **Discoverability** | Can't tell what it is / thinks coding required | Instantly clear what it does + that an assistant runs it |
| A2 | **Setup friction** | Dead-end on install/build | One-time setup obvious, errors say exactly what to do |
| A3 | **Guidance** | Had to read source / guess flags | Docs/skill walked me through with no dead-ends |
| A4 | **Conversion** | `init` failed / unusable output | Clean run, summary I understand |
| A5 | **Trust / accuracy** | Headline numbers wrong, couldn't tell or fix | Numbers matched my model (or I fixed a mis-map easily) |
| A6 | **Handoff readiness** | Wouldn't hand this to a dev | Confident the bundle is dev-ready |
| A7 | **Overall confidence** ("woah, it worked") | Frustrated/abandon | Delighted, would recommend |

Also record: `blockingIssues[]`, `stumbles[]` (where I paused/got confused),
`suggestions[]`, and `quotes[]` (what the persona would actually say).

## Stage 2 — Coding-agent handoff (the "exactly what I need" half)

The agent gets ONLY the `chunked/` folder + the goal "build a what-if web app."
It must actually write and RUN a small integration (call `run()` with an override,
read named outputs, compare to base case) — empirical, not opinion.

| # | Dimension | 0 | 5 |
|---|-----------|---|---|
| C1 | **Bundle clarity** | Had to reverse-engineer | INTEGRATION.md told me everything |
| C2 | **Time-to-first-success** | Long flailing | Called `run()` and got outputs in minutes |
| C3 | **Contract completeness** | Missing inputs/outputs/types | Levers + answers + formats all present |
| C4 | **Correctness** | My integration's numbers didn't tie out | Base case matched; what-if moved sensibly |
| C5 | **"Exactly what I need"** | Would ask for more | Could build the app immediately |

Also record: `ranSuccessfully` (bool), `baseCaseMatched` (bool),
`whatIfWorked` (bool), `friction[]`, `missing[]`, `suggestions[]`, `quotes[]`.

## Benchmark gate (the target)

A persona **passes the benchmark** when, in one end-to-end run:
- Stage 1 A4, A5, A6, A7 are all ≥ 4, AND
- Stage 2 C4 = 5 (`baseCaseMatched && whatIfWorked` true) and C5 ≥ 4.

The headline acceptance scenario: *PE analyst → "turn this into an LP web app,
walk me through it" → "woah, it worked, I'll hand this to my coding agent" →
coding agent: "this is easy to understand and exactly what I need."* That is
`pe-buyout-associate` passing the gate with quotes that match the spirit above —
but we want the whole matrix to pass, not just one.
