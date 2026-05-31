export const meta = {
  name: 'phase0-rebaseline-journey',
  description: 'Re-baseline all 12 personas: analyst journey (UX + grounded trust) -> empirical coding-agent handoff -> scoreboard synthesis',
  phases: [
    { title: 'Journey', detail: 'per persona: analyst A1-A7 + trust audit, then empirical coder C1-C5' },
    { title: 'Synthesis', detail: 'compute pass/12 + avg A5/A7/C5 + binding dims + top fixes' },
  ],
}

const personas = (typeof args !== 'undefined' && args && Array.isArray(args.personas)) ? args.personas : [
  {slug:"pe-buyout-associate",role:"PE Associate",assetClass:"pe_buyout",skillLevel:"non-technical",seniority:"associate",goal:"Turn our LBO model into an explorable web app for LPs.",headlineMetrics:["grossMOIC","grossIRR","exitMultiple","totalCarry"]},
  {slug:"growth-equity-vp",role:"Growth Equity VP",assetClass:"growth_equity",skillLevel:"semi-technical",seniority:"vp",goal:"Build an IC sensitivity tool and hand the engine to our dev.",headlineMetrics:["grossMOIC","grossIRR","exitMultiple"]},
  {slug:"vc-fund-partner",role:"VC Fund Partner",assetClass:"vc_fund",skillLevel:"non-technical",seniority:"partner",goal:"Give LPs a portal showing fund returns and a power-law what-if.",headlineMetrics:["grossMOIC","grossIRR","tvpi","dpi"]},
  {slug:"re-valueadd-analyst",role:"Real Estate Analyst",assetClass:"real_estate",skillLevel:"non-technical",seniority:"analyst",goal:"Investor web app with cap-rate and rent-growth sliders.",headlineMetrics:["grossMOIC","grossIRR","terminalValue"]},
  {slug:"infra-fund-director",role:"Infrastructure Director",assetClass:"infrastructure",skillLevel:"semi-technical",seniority:"director",goal:"Long-hold yield/IRR explorer for the investment committee.",headlineMetrics:["grossIRR","terminalValue"]},
  {slug:"credit-directlending-analyst",role:"Private Credit Analyst",assetClass:"private_credit",skillLevel:"technical",seniority:"analyst",goal:"A yield + covenant calculator app for deal screening.",headlineMetrics:["grossIRR","grossMOIC"]},
  {slug:"corp-fpa-manager",role:"FP&A Manager",assetClass:"corporate_3statement",skillLevel:"non-technical",seniority:"manager",goal:"A budget scenario tool execs can use without Excel.",headlineMetrics:["terminalValue","ebitda"]},
  {slug:"ma-sellside-analyst",role:"M&A Analyst (sell-side)",assetClass:"ma_lbo",skillLevel:"semi-technical",seniority:"analyst",goal:"A buyer-returns explorer to include with the CIM.",headlineMetrics:["grossMOIC","grossIRR","exitMultiple"]},
  {slug:"saas-growth-operator",role:"SaaS Founder/Operator",assetClass:"saas_metrics",skillLevel:"technical",seniority:"founder",goal:"A board-facing ARR scenario app.",headlineMetrics:["terminalValue","exitMultiple"]},
  {slug:"searchfund-searcher",role:"Search Fund Searcher",assetClass:"search_fund",skillLevel:"non-technical",seniority:"principal",goal:"An investor-update app showing returns under a few cases.",headlineMetrics:["grossMOIC","grossIRR"]},
  {slug:"familyoffice-fof-ir",role:"Family Office IR",assetClass:"fund_of_funds",skillLevel:"non-technical",seniority:"ir",goal:"A portfolio roll-up dashboard for the principals.",headlineMetrics:["tvpi","dpi","grossIRR"]},
  {slug:"realestate-debt-cfo",role:"Portfolio CFO (RE debt)",assetClass:"real_estate_debt",skillLevel:"semi-technical",seniority:"cfo",goal:"A debt-amortization + DSCR covenant monitor for lenders.",headlineMetrics:["terminalValue","exitDebt"]},
]

const PERSONA_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['a1','a2','a3','a4','a6','a7','stumbles','blockingIssues','suggestions','quotes'],
  properties: {
    a1: { type: 'integer', minimum: 0, maximum: 5, description: 'Discoverability' },
    a2: { type: 'integer', minimum: 0, maximum: 5, description: 'Setup friction' },
    a3: { type: 'integer', minimum: 0, maximum: 5, description: 'Guidance' },
    a4: { type: 'integer', minimum: 0, maximum: 5, description: 'Conversion (clean run, summary understood)' },
    a6: { type: 'integer', minimum: 0, maximum: 5, description: 'Handoff readiness' },
    a7: { type: 'integer', minimum: 0, maximum: 5, description: 'Overall confidence / woah-it-worked' },
    stumbles: { type: 'array', items: { type: 'string' } },
    blockingIssues: { type: 'array', items: { type: 'string' } },
    suggestions: { type: 'array', items: { type: 'string' } },
    quotes: { type: 'array', items: { type: 'string' }, description: 'what this persona would actually say' },
  },
}

const AUDIT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['a5','accuracyVerified','checkedMetrics','discrepancies','notes'],
  properties: {
    a5: { type: 'integer', minimum: 0, maximum: 5, description: 'Trust/accuracy: do headline numbers match the model?' },
    accuracyVerified: { type: 'boolean' },
    checkedMetrics: { type: 'array', items: { type: 'string' }, description: 'metric: summaryValue vs groundTruthValue' },
    discrepancies: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

const CODER_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['c1','c2','c3','c5','ranSuccessfully','baseCaseMatched','whatIfWorked','overrideUsed','friction','missing','quotes'],
  properties: {
    c1: { type: 'integer', minimum: 0, maximum: 5, description: 'Bundle clarity' },
    c2: { type: 'integer', minimum: 0, maximum: 5, description: 'Time-to-first-success' },
    c3: { type: 'integer', minimum: 0, maximum: 5, description: 'Contract completeness' },
    c5: { type: 'integer', minimum: 0, maximum: 5, description: 'Exactly-what-I-need' },
    ranSuccessfully: { type: 'boolean' },
    baseCaseMatched: { type: 'boolean', description: 'integration base case tied out to ground truth' },
    whatIfWorked: { type: 'boolean', description: 'an override moved an output in the sensible direction' },
    overrideUsed: { type: 'string', description: 'the named input + value the integration changed' },
    friction: { type: 'array', items: { type: 'string' } },
    missing: { type: 'array', items: { type: 'string' } },
    quotes: { type: 'array', items: { type: 'string' } },
  },
}

phase('Journey')
const journey = await pipeline(
  personas,
  // STAGE 1: analyst journey — persona UX judge + independent grounded trust auditor, in parallel
  async (p) => {
    const dir = `engines/_personas/${p.slug}`
    const [persona, audit] = await parallel([
      () => agent(
`You ROLE-PLAY a real finance user onboarding excel-to-engine through an AI assistant, then score the experience on the analyst-journey rubric.

PERSONA: ${p.role} (${p.assetClass}), skill level: ${p.skillLevel}, seniority: ${p.seniority}.
GOAL (in their words): "${p.goal}"

Their model has ALREADY been converted to ${dir}/chunked/ (a prior step ran 'ete init'). Simulate the journey faithfully:
1. DISCOVERY: Read ONLY what a newcomer would: README.md, GETTING_STARTED.md, and skill/SKILL.md (the guided-onboarding play at the top). Judge whether a non-technical finance person can tell what this is and that an AI assistant runs it.
2. SETUP & GUIDANCE: from those docs, is setup obvious? do the docs walk them through with no dead-ends?
3. CONVERSION: run \`node cli/index.mjs summary ${dir}/\` and read ${dir}/chunked/INTEGRATION.md. Is the summary something THIS persona understands (right metrics named for their asset class)? Note any metric that is mislabeled, fabricated, or irrelevant to their world.
4. HANDOFF READINESS & CONFIDENCE: would they confidently hand ${dir}/chunked/ to a developer? would they say "woah, it worked"?

Score A1 discoverability, A2 setup, A3 guidance, A4 conversion, A6 handoff-readiness, A7 overall-confidence — each 0-5 per rubric (tests/personas/lib/rubric.md). Be a tough but fair grader; reserve 5 for genuinely delightful. Record concrete stumbles, blocking issues, suggestions, and quotes the persona would actually say. Do NOT score A5 (trust/accuracy) — a separate auditor owns it. Return ONLY the structured object.`,
        { label: `analyst:${p.slug}`, phase: 'Journey', schema: PERSONA_SCHEMA }),

      () => agent(
`You are a TRUST AUDITOR grounding the analyst's A5 (trust/accuracy) dimension empirically for one converted model.

MODEL DIR: ${dir}/  (asset class: ${p.assetClass}; headline metrics this persona cares about: ${(p.headlineMetrics||[]).join(', ')})

Do this:
1. Run \`node cli/index.mjs summary ${dir}/\` and capture the headline numbers it presents.
2. Establish ground truth independently: read ${dir}/chunked/_ground-truth.json and ${dir}/chunked/named-outputs.json (and run \`node cli/index.mjs verify ${dir}/\`). For each headline metric the summary shows, find the corresponding ground-truth cell value.
3. Compare: does each surfaced headline number MATCH the model's own ground truth (within rounding)? Is each number LABELED correctly for this asset class (e.g. cap-rate vs exit-multiple, TVPI/DPI for a fund, DSCR for credit)? A number that is right but mislabeled, or a metric fabricated for the wrong model family, is an accuracy failure.
4. Score A5 (0 = headline numbers wrong and the user couldn't tell; 5 = numbers matched the model and were correctly labeled). Set accuracyVerified true only if every checked headline metric both matches ground truth AND is correctly labeled. List checkedMetrics as "name: summaryValue vs gtValue", and any discrepancies.

Return ONLY the structured object.`,
        { label: `audit:${p.slug}`, phase: 'Journey', schema: AUDIT_SCHEMA }),
    ])
    return { p, persona, audit }
  },
  // STAGE 2: empirical coding-agent handoff — actually build + run an integration
  async (prev) => {
    const { p } = prev
    const dir = `engines/_personas/${p.slug}`
    const coder = await agent(
`You are a DEVELOPER agent handed ONLY a converted-model bundle and asked to build a what-if web app for it. Prove the bundle works by actually writing and RUNNING a small integration — this is empirical, not opinion.

BUNDLE (this is ALL you get): ${dir}/chunked/
TASK: "build a what-if web app" for a ${p.role}. You don't need the UI — you need to prove the engine contract is usable.

Do this:
1. Read ${dir}/chunked/INTEGRATION.md, named-inputs.json (the levers), named-outputs.json (the answers), and cell-types.json. Treat INTEGRATION.md as your only guide.
2. Write a small ESM script to a SCRATCH path INSIDE the bundle's parent so it's gitignored: ${dir}/_handoff-probe/probe.mjs. It must: import the engine (${dir}/chunked/engine.js), call run() for the BASE case, read the headline named outputs, then call run({<one named input>: <changed value>}) for a WHAT-IF, and print base vs what-if for the headline outputs.
3. RUN it with node. Capture output.
4. Empirically determine: ranSuccessfully (did it execute?), baseCaseMatched (do base-case outputs equal the model's ground truth / named-output base values?), whatIfWorked (did your override move an output in a sensible direction?). Record the exact override you used in overrideUsed.
5. Score C1 bundle-clarity, C2 time-to-first-success, C3 contract-completeness, C5 exactly-what-I-need (0-5, rubric tests/personas/lib/rubric.md). (C4 correctness is derived from your booleans, don't score it.) Record friction, missing pieces, and quotes a developer would say.

Be rigorous: if you couldn't get the base case to tie out, baseCaseMatched MUST be false. Return ONLY the structured object.`,
      { label: `coder:${p.slug}`, phase: 'Journey', schema: CODER_SCHEMA })
    return { ...prev, coder }
  },
)

phase('Synthesis')
const valid = journey.filter(Boolean)
// Deterministic gate computation (no LLM): A4,A5,A6,A7>=4 AND C4(=baseCaseMatched&&whatIfWorked) AND C5>=4
const scored = valid.map(({ p, persona, audit, coder }) => {
  const a = { a1:persona.a1,a2:persona.a2,a3:persona.a3,a4:persona.a4,a5:audit.a5,a6:persona.a6,a7:persona.a7 }
  const c4pass = !!(coder.baseCaseMatched && coder.whatIfWorked)
  const binding = []
  if (a.a4 < 4) binding.push('A4')
  if (a.a5 < 4) binding.push('A5')
  if (a.a6 < 4) binding.push('A6')
  if (a.a7 < 4) binding.push('A7')
  if (!c4pass) binding.push('C4')
  if (coder.c5 < 4) binding.push('C5')
  const pass = binding.length === 0
  return { slug: p.slug, assetClass: p.assetClass, a, c: { c1:coder.c1,c2:coder.c2,c3:coder.c3,c4pass,c5:coder.c5 },
    pass, binding, accuracyVerified: audit.accuracyVerified,
    persona, audit, coder }
})

const n = scored.length
const avg = (xs) => Math.round((xs.reduce((s,x)=>s+x,0)/xs.length)*100)/100
const board = {
  total: n,
  pass: scored.filter(s=>s.pass).length,
  avgA5: avg(scored.map(s=>s.a.a5)),
  avgA7: avg(scored.map(s=>s.a.a7)),
  avgC5: avg(scored.map(s=>s.c.c5)),
  passing: scored.filter(s=>s.pass).map(s=>s.slug),
  failing: scored.filter(s=>!s.pass).map(s=>({ slug:s.slug, binding:s.binding })),
}

const synthesis = await agent(
`You are synthesizing a benchmark re-baseline for excel-to-engine's 12-persona analyst-UX gate (Wave 4 lift measurement).

Here is the DETERMINISTICALLY-COMPUTED scoreboard and per-persona detail (gate already computed in code; trust it):
${JSON.stringify({ board, perPersona: scored.map(s=>({ slug:s.slug, assetClass:s.assetClass, pass:s.pass, binding:s.binding, scores:{...s.a, ...s.c}, accuracyVerified:s.accuracyVerified, analystStumbles:s.persona.stumbles, analystBlocking:s.persona.blockingIssues, auditDiscrepancies:s.audit.discrepancies, coderFriction:s.coder.friction, coderMissing:s.coder.missing })) }, null, 2)}

Produce:
1. A one-paragraph narrative: where do we stand vs the prior trajectory (Wave1 2/12 A7=3.50 C5=3.33 A5~3.1; Wave2 3/12 A7=3.92 C5=3.83; Wave3 3/12 A7=4.00 C5=3.75 A5=3.50; Wave4 capstone-only 5/5)? Did searchfund/corp/saas/credit flip as expected?
2. The single most common BINDING dimension across failing personas, and the specific root cause (tie it to the documented backlog: multi-sheet IRR static literals; intra-sheet topo-sort; per-year covenant series; non-defined-name levers; model-type misclassification).
3. The top 3 fixes in ROI order to maximize pass/12 next, each with the personas it would flip and why.
4. Any accuracy failures (accuracyVerified=false) — these are the most serious; call them out explicitly.

Return a tight markdown report (no preamble).`,
  { label: 'synthesis', phase: 'Synthesis' })

return { board, scored, synthesis }
