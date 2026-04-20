/**
 * excel-to-engine — Standard PE Waterfall Calculator
 *
 * Generic distribution waterfall supporting common private equity
 * and real estate fund structures: preferred returns, catch-ups,
 * tiered carried interest, and European/American variations.
 *
 * @license MIT
 */

/**
 * @typedef {Object} WaterfallTier
 * @property {string} name - Human-readable tier name (e.g., "Preferred Return")
 * @property {number} hurdle - Cumulative IRR hurdle (e.g., 0.08 for 8% pref). Ignored
 *                              if `hurdleMOIC` is set. Set to 0 for catch-up / flat splits.
 * @property {number} [hurdleMOIC] - Flat MOIC hurdle (e.g., 1.40 for a 1.40x PPS trigger).
 *                                   When set, used INSTEAD of `hurdle` — does NOT compound
 *                                   with hold period. Common in VC Class A PPS waterfalls
 *                                   where the trigger is a price-per-share multiple with
 *                                   no IRR component. Mutually exclusive with `hurdle`.
 * @property {number} lpSplit - LP share of distributions in this tier (0.0 - 1.0)
 * @property {number} gpSplit - GP share of distributions in this tier (0.0 - 1.0)
 * @property {string} [type='standard'] - Tier type: 'standard', 'catchup', or 'return_of_capital'
 * @property {number} [catchupTarget] - For catch-up tiers: GP's target share of total profit
 */

/**
 * @typedef {Object} WaterfallResult
 * @property {number} totalDistributed - Total amount distributed
 * @property {number} lpTotal - Total LP distributions
 * @property {number} gpTotal - Total GP (carry) distributions
 * @property {number} lpMOIC - LP multiple on invested capital
 * @property {number} gpCarryPercent - GP carry as % of total profit
 * @property {Array<TierResult>} tiers - Per-tier breakdown
 * @property {number} undistributed - Any remaining proceeds not distributed
 */

/**
 * @typedef {Object} TierResult
 * @property {string} name - Tier name
 * @property {number} distributed - Total distributed in this tier
 * @property {number} lpAmount - LP share in this tier
 * @property {number} gpAmount - GP share in this tier
 */

/**
 * Compute a standard PE distribution waterfall.
 *
 * Distributes net proceeds through a series of tiers, each with LP/GP splits
 * and hurdle rates. Supports preferred returns, catch-up provisions, and
 * tiered carried interest.
 *
 * @param {number} netProceeds - Total distributable proceeds (after expenses)
 * @param {number} equityBasis - Total equity invested (used for hurdle calculations)
 * @param {WaterfallTier[]} tiers - Ordered array of waterfall tiers
 * @param {Object} [options={}] - Additional options
 * @param {number} [options.holdPeriodYears] - Investment hold period for annualized calcs
 * @param {boolean} [options.compoundHurdles=true] - Whether hurdles are compounded annually
 * @returns {WaterfallResult}
 *
 * @example
 * // Standard 80/20 with 8% pref and catch-up
 * const tiers = [
 *   { name: 'Return of Capital', hurdle: 0, lpSplit: 1.0, gpSplit: 0.0, type: 'return_of_capital' },
 *   { name: 'Preferred Return (8%)', hurdle: 0.08, lpSplit: 1.0, gpSplit: 0.0 },
 *   { name: 'GP Catch-Up', hurdle: 0, lpSplit: 0.0, gpSplit: 1.0, type: 'catchup', catchupTarget: 0.20 },
 *   { name: 'Residual 80/20', hurdle: Infinity, lpSplit: 0.80, gpSplit: 0.20 },
 * ];
 * computeWaterfall(200_000_000, 100_000_000, tiers, { holdPeriodYears: 5 });
 */
export function computeWaterfall(netProceeds, equityBasis, tiers, options = {}) {
  const { holdPeriodYears = 1, compoundHurdles = true } = options;

  let remaining = netProceeds;
  let cumulativeDistributed = 0;
  let lpTotal = 0;
  let gpTotal = 0;
  const tierResults = [];

  for (const tier of tiers) {
    if (remaining <= 0) {
      tierResults.push({
        name: tier.name,
        distributed: 0,
        lpAmount: 0,
        gpAmount: 0,
      });
      continue;
    }

    let tierAmount = 0;

    if (tier.type === 'return_of_capital') {
      // Return of capital: distribute up to equity basis to LP
      const needed = Math.max(0, equityBasis - cumulativeDistributed);
      tierAmount = Math.min(remaining, needed);

    } else if (tier.type === 'catchup') {
      // Catch-up: GP receives 100% until they reach catchupTarget of total profit
      const totalProfit = netProceeds - equityBasis;
      if (totalProfit <= 0) {
        tierAmount = 0;
      } else {
        const gpTargetAmount = totalProfit * (tier.catchupTarget || 0.20);
        const gpNeeded = Math.max(0, gpTargetAmount - gpTotal);
        tierAmount = Math.min(remaining, gpNeeded);
      }

    } else if (tier.hurdle === Infinity || tier.hurdle >= 100) {
      // Residual tier: everything remaining
      tierAmount = remaining;

    } else if (typeof tier.hurdleMOIC === 'number' && tier.hurdleMOIC > 1) {
      // Flat MOIC hurdle (no IRR compounding). Example: 1.40x Class A PPS —
      // distribute until cumulative proceeds reach (hurdleMOIC × equityBasis).
      // Invariant: hold period does NOT move this hurdle, by design.
      const targetCumulative = equityBasis * tier.hurdleMOIC;
      const needed = Math.max(0, targetCumulative - cumulativeDistributed);
      tierAmount = Math.min(remaining, needed);

    } else if (tier.hurdle > 0) {
      // Hurdle tier: distribute until cumulative distributions reach hurdle return
      let hurdleAmount;
      if (compoundHurdles && holdPeriodYears > 1) {
        hurdleAmount = equityBasis * (Math.pow(1 + tier.hurdle, holdPeriodYears) - 1);
      } else {
        hurdleAmount = equityBasis * tier.hurdle * holdPeriodYears;
      }
      // Amount needed to reach this hurdle (above return of capital)
      const targetCumulative = equityBasis + hurdleAmount;
      const needed = Math.max(0, targetCumulative - cumulativeDistributed);
      tierAmount = Math.min(remaining, needed);

    } else {
      // Zero hurdle, standard split: distribute everything remaining
      tierAmount = remaining;
    }

    // Apply LP/GP split
    const lpAmount = tierAmount * (tier.lpSplit || 0);
    const gpAmount = tierAmount * (tier.gpSplit || 0);

    tierResults.push({
      name: tier.name,
      distributed: tierAmount,
      lpAmount,
      gpAmount,
    });

    lpTotal += lpAmount;
    gpTotal += gpAmount;
    cumulativeDistributed += tierAmount;
    remaining -= tierAmount;
  }

  const totalProfit = Math.max(0, netProceeds - equityBasis);

  return {
    totalDistributed: cumulativeDistributed,
    lpTotal,
    gpTotal,
    lpMOIC: equityBasis > 0 ? lpTotal / equityBasis : 0,
    gpCarryPercent: totalProfit > 0 ? gpTotal / totalProfit : 0,
    tiers: tierResults,
    undistributed: Math.max(0, remaining),
  };
}

/**
 * Create a standard American-style waterfall with preferred return and carry.
 *
 * Convenience function that builds a tier array for the most common PE structure:
 * 1. Return of capital (100% to LP)
 * 2. Preferred return (100% to LP)
 * 3. GP catch-up (100% to GP until target carry %)
 * 4. Residual split
 *
 * @param {Object} params
 * @param {number} params.prefReturn - Preferred return rate (e.g., 0.08)
 * @param {number} params.carryPercent - GP carry percentage (e.g., 0.20)
 * @param {number} params.residualLPSplit - LP share after catch-up (e.g., 0.80)
 * @param {boolean} [params.hasCatchup=true] - Include catch-up provision
 * @returns {WaterfallTier[]}
 */
export function createAmericanWaterfall({ prefReturn, carryPercent, residualLPSplit, hasCatchup = true }) {
  const tiers = [
    {
      name: 'Return of Capital',
      hurdle: 0,
      lpSplit: 1.0,
      gpSplit: 0.0,
      type: 'return_of_capital',
    },
    {
      name: `Preferred Return (${(prefReturn * 100).toFixed(1)}%)`,
      hurdle: prefReturn,
      lpSplit: 1.0,
      gpSplit: 0.0,
    },
  ];

  if (hasCatchup) {
    tiers.push({
      name: 'GP Catch-Up',
      hurdle: 0,
      lpSplit: 0.0,
      gpSplit: 1.0,
      type: 'catchup',
      catchupTarget: carryPercent,
    });
  }

  tiers.push({
    name: `Residual ${Math.round(residualLPSplit * 100)}/${Math.round((1 - residualLPSplit) * 100)}`,
    hurdle: Infinity,
    lpSplit: residualLPSplit,
    gpSplit: 1 - residualLPSplit,
  });

  return tiers;
}

/**
 * Create a multi-hurdle European-style waterfall.
 *
 * European waterfalls apply to the entire fund on an aggregate basis, with
 * multiple return hurdles triggering increasing GP carry percentages.
 *
 * @param {Array<{hurdle: number, carry: number}>} hurdleTiers - Ordered hurdle/carry pairs
 * @returns {WaterfallTier[]}
 *
 * @example
 * createEuropeanWaterfall([
 *   { hurdle: 0.08, carry: 0.00 },  // Below 8%: no carry
 *   { hurdle: 0.12, carry: 0.20 },  // 8-12%: 20% carry
 *   { hurdle: 0.15, carry: 0.25 },  // 12-15%: 25% carry
 *   { hurdle: Infinity, carry: 0.30 }, // Above 15%: 30% carry
 * ]);
 */
export function createEuropeanWaterfall(hurdleTiers) {
  const tiers = [
    {
      name: 'Return of Capital',
      hurdle: 0,
      lpSplit: 1.0,
      gpSplit: 0.0,
      type: 'return_of_capital',
    },
  ];

  for (const ht of hurdleTiers) {
    const lpShare = 1 - ht.carry;
    tiers.push({
      name: ht.carry === 0
        ? `Preferred Return (${(ht.hurdle * 100).toFixed(0)}%)`
        : `${(ht.carry * 100).toFixed(0)}% Carry (to ${ht.hurdle === Infinity ? '...' : (ht.hurdle * 100).toFixed(0) + '%'})`,
      hurdle: ht.hurdle,
      lpSplit: lpShare,
      gpSplit: ht.carry,
    });
  }

  return tiers;
}

/**
 * Create a flat-MOIC-hurdle waterfall (no IRR pref).
 *
 * Used for promote structures where the trigger is a Price-Per-Share multiple
 * (or similar fixed-MOIC threshold) rather than a compounding IRR hurdle. The
 * hurdle does NOT grow with hold period. Common in tech/VC Class A PPS
 * waterfalls and in some real-asset funds where the LP is protected only by
 * a MOIC floor.
 *
 * Example: a VC fund with 20% promote above 1.40x Class A PPS, no IRR pref.
 *
 * @param {Object} params
 * @param {number} params.hurdleMOIC - Flat MOIC hurdle (e.g., 1.40)
 * @param {number} params.carryPercent - GP carry above the hurdle (e.g., 0.20)
 * @returns {WaterfallTier[]}
 *
 * @example
 * const tiers = createMoicHurdleWaterfall({ hurdleMOIC: 1.40, carryPercent: 0.20 });
 * computeWaterfall(200_000_000, 100_000_000, tiers);  // 2.0x MOIC
 * // → gpTotal = 0.20 × (200M - 140M) = $12M
 */
export function createMoicHurdleWaterfall({ hurdleMOIC, carryPercent }) {
  return [
    {
      name: 'Return of Capital',
      hurdle: 0,
      lpSplit: 1.0,
      gpSplit: 0.0,
      type: 'return_of_capital',
    },
    {
      name: `MOIC Hurdle (${hurdleMOIC.toFixed(2)}x)`,
      hurdleMOIC,
      lpSplit: 1.0,
      gpSplit: 0.0,
    },
    {
      name: `Residual ${Math.round((1 - carryPercent) * 100)}/${Math.round(carryPercent * 100)}`,
      hurdle: Infinity,
      lpSplit: 1 - carryPercent,
      gpSplit: carryPercent,
    },
  ];
}
