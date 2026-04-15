/**
 * Delta Cascade — The core financial computation chain.
 *
 * Computes how user adjustments flow through to returns:
 *   Adjustments → Annual P&L → Exit EBITDA → Terminal Value
 *     → Exit Equity → MOIC → IRR → Carry
 *
 * Uses ground truth base case values + proportional deltas.
 * Does NOT re-run the full chunked engine (too slow/memory).
 *
 * @license MIT
 */

import { computeIRR } from '../../lib/irr.mjs';
import { computeWaterfall, createAmericanWaterfall } from '../../lib/waterfall.mjs';
import { resolveCell } from '../../lib/manifest.mjs';
import { detectDateColumns } from '../extractors/date-detector.mjs';
import { aggregateAnnual, aggregateSegmentPnL, computeGrowthRates, computeCAGR } from '../extractors/annual-aggregator.mjs';
import { resolveLineItem, computeLineItemDelta, computeCapitalizationDelta } from '../extractors/line-item-resolver.mjs';

/**
 * Compute a full scenario from manifest + ground truth + adjustments.
 *
 * @param {Object} manifest - Model manifest
 * @param {Object} gt - Ground truth {addr: value}
 * @param {Object} adjustments - Parsed adjustments
 * @returns {{ base, scenario, deltas, annualPnL }}
 */
export function computeScenario(manifest, gt, adjustments = {}) {
  // Detect date columns for aggregation
  const dateResult = detectDateColumns(gt, {
    sheet: manifest.timeline?.dateSheet,
    row: manifest.timeline?.dateRow,
  });

  // Step 1: Resolve base case annual P&L
  const segments = manifest.segments || [];
  const basePnL = aggregateSegmentPnL(gt, segments, dateResult);

  // Step 2: Apply adjustments to get scenario P&L
  const scenarioPnL = applyPnLAdjustments(basePnL, adjustments, manifest, gt, dateResult);

  // Step 3: Determine exit parameters
  const baseExitYear = manifest.timeline?.exitYear;
  const scenarioExitYear = adjustments.exitYear || baseExitYear;
  const investmentYear = manifest.timeline?.investmentYear;
  const baseHoldPeriod = baseExitYear - investmentYear;
  const scenarioHoldPeriod = adjustments.holdPeriod || (scenarioExitYear - investmentYear);

  // Step 4: Compute exit EBITDA
  const baseExitEBITDA = basePnL.totals.ebitda[baseExitYear] || resolveBaseOutput(manifest, gt, 'exitEBITDA');
  const scenarioExitEBITDA = scenarioPnL.totals.ebitda[scenarioExitYear] || baseExitEBITDA;

  // Step 5: Compute terminal value
  const baseTV = computeTerminalValue(manifest, gt, basePnL, baseExitYear, {});
  const scenarioTV = computeTerminalValue(manifest, gt, scenarioPnL, scenarioExitYear, adjustments);

  // Step 6: Compute exit equity
  const baseEquity = computeExitEquity(manifest, gt, baseTV, {});
  const scenarioEquity = computeExitEquity(manifest, gt, scenarioTV, adjustments);

  // Step 7: Compute returns
  const equityBasis = adjustments.equityOverride || resolveBaseOutput(manifest, gt, 'equityBasis');

  const baseMOIC = equityBasis ? baseEquity / equityBasis : null;
  const scenarioMOIC = equityBasis ? scenarioEquity / equityBasis : null;

  // Step 8: Compute IRR
  const baseCashFlows = buildCashFlows(equityBasis, baseEquity, baseHoldPeriod, manifest, gt, {});
  const scenarioCashFlows = buildCashFlows(equityBasis, scenarioEquity,
    scenarioHoldPeriod, manifest, gt, adjustments);

  const baseIRR = baseCashFlows ? computeIRR(baseCashFlows) : resolveBaseOutput(manifest, gt, 'grossIRR');
  const scenarioIRR = scenarioCashFlows ? computeIRR(scenarioCashFlows) : null;

  // Step 9: Compute carry via waterfall
  const baseCarry = computeCarryFromWaterfall(manifest, gt, baseEquity, equityBasis, baseHoldPeriod, {});
  const scenarioCarry = computeCarryFromWaterfall(manifest, gt, scenarioEquity, equityBasis,
    scenarioHoldPeriod, adjustments);

  // Step 10: Compute net returns (after carry)
  const baseNetEquity = baseEquity - (baseCarry?.gpTotal || 0);
  const scenarioNetEquity = scenarioEquity - (scenarioCarry?.gpTotal || 0);
  const baseNetMOIC = equityBasis ? baseNetEquity / equityBasis : null;
  const scenarioNetMOIC = equityBasis ? scenarioNetEquity / equityBasis : null;

  const baseNetCF = baseCashFlows ? [...baseCashFlows] : null;
  if (baseNetCF && baseCarry) baseNetCF[baseNetCF.length - 1] -= baseCarry.gpTotal;
  const scenarioNetCF = scenarioCashFlows ? [...scenarioCashFlows] : null;
  if (scenarioNetCF && scenarioCarry) scenarioNetCF[scenarioNetCF.length - 1] -= scenarioCarry.gpTotal;

  const baseNetIRR = baseNetCF ? computeIRR(baseNetCF) : resolveBaseOutput(manifest, gt, 'netIRR');
  const scenarioNetIRR = scenarioNetCF ? computeIRR(scenarioNetCF) : null;

  // Step 11: Price per share
  const sharesOutstanding = manifest.customCells?.sharesOutstanding
    ? resolveCell(gt, manifest.customCells.sharesOutstanding) : null;
  const basePPS = sharesOutstanding ? baseNetEquity / sharesOutstanding : null;
  const scenarioPPS = sharesOutstanding ? scenarioNetEquity / sharesOutstanding : null;

  // Assemble result
  const base = {
    exitEBITDA: baseExitEBITDA,
    terminalValue: baseTV,
    exitEquity: baseEquity,
    equityBasis,
    grossMOIC: baseMOIC,
    grossIRR: baseIRR,
    netMOIC: baseNetMOIC,
    netIRR: baseNetIRR,
    totalCarry: baseCarry?.gpTotal || null,
    carryDetail: baseCarry,
    pricePerShare: basePPS,
    exitYear: baseExitYear,
    holdPeriod: baseHoldPeriod,
  };

  const scenario = {
    exitEBITDA: scenarioExitEBITDA,
    terminalValue: scenarioTV,
    exitEquity: scenarioEquity,
    equityBasis: adjustments.equityOverride || equityBasis,
    grossMOIC: scenarioMOIC,
    grossIRR: scenarioIRR,
    netMOIC: scenarioNetMOIC,
    netIRR: scenarioNetIRR,
    totalCarry: scenarioCarry?.gpTotal || null,
    carryDetail: scenarioCarry,
    pricePerShare: scenarioPPS,
    exitYear: scenarioExitYear,
    holdPeriod: scenarioHoldPeriod,
  };

  const deltas = {};
  for (const key of Object.keys(base)) {
    if (key === 'carryDetail') continue;
    const b = base[key];
    const s = scenario[key];
    if (typeof b === 'number' && typeof s === 'number') {
      deltas[key] = {
        absolute: s - b,
        percent: b !== 0 ? (s - b) / Math.abs(b) : null,
      };
    }
  }

  return {
    base,
    scenario,
    deltas,
    annualPnL: { base: basePnL, scenario: scenarioPnL },
  };
}

/**
 * Compute attribution — how much each individual adjustment contributes.
 */
export function computeAttribution(manifest, gt, adjustments) {
  const base = computeScenario(manifest, gt, {});
  const full = computeScenario(manifest, gt, adjustments);

  const contributions = {};
  const flatAdj = flattenAdjustments(adjustments);

  for (const [key, adj] of Object.entries(flatAdj)) {
    const individual = computeScenario(manifest, gt, unflattenAdjustment(key, adj));
    contributions[key] = {
      label: key,
      irrDelta: (individual.scenario.grossIRR || 0) - (base.base.grossIRR || 0),
      moicDelta: (individual.scenario.grossMOIC || 0) - (base.base.grossMOIC || 0),
      carryDelta: (individual.scenario.totalCarry || 0) - (base.base.totalCarry || 0),
      tvDelta: (individual.scenario.terminalValue || 0) - (base.base.terminalValue || 0),
    };
  }

  // Interaction effect = total - sum of individual
  const totalIRRDelta = (full.scenario.grossIRR || 0) - (base.base.grossIRR || 0);
  const sumIRR = Object.values(contributions).reduce((s, c) => s + c.irrDelta, 0);
  contributions._interaction = {
    label: 'Interaction effects',
    irrDelta: totalIRRDelta - sumIRR,
    moicDelta: ((full.scenario.grossMOIC || 0) - (base.base.grossMOIC || 0))
      - Object.values(contributions).reduce((s, c) => s + c.moicDelta, 0),
    carryDelta: ((full.scenario.totalCarry || 0) - (base.base.totalCarry || 0))
      - Object.values(contributions).reduce((s, c) => s + c.carryDelta, 0),
  };

  return {
    base: base.base,
    scenario: full.scenario,
    contributions,
    totalDelta: {
      irr: totalIRRDelta,
      moic: (full.scenario.grossMOIC || 0) - (base.base.grossMOIC || 0),
      carry: (full.scenario.totalCarry || 0) - (base.base.totalCarry || 0),
    },
  };
}

// ---------------------------------------------------------------------------
// Internal computation steps
// ---------------------------------------------------------------------------

function applyPnLAdjustments(basePnL, adjustments, manifest, gt, dateResult) {
  // Deep clone the base P&L
  const scenario = JSON.parse(JSON.stringify(basePnL));

  // Revenue adjustments
  for (const adj of adjustments.revenueAdj || []) {
    const segData = scenario.segments[adj.segment];
    if (!segData) continue;

    for (const year of Object.keys(segData.annual)) {
      if (adj.type === 'percent') {
        const delta = segData.annual[year] * adj.value;
        segData.annual[year] += delta;
      } else {
        segData.annual[year] += adj.value;
      }
    }
  }

  // Revenue growth overrides
  for (const adj of adjustments.revenueGrowth || []) {
    const segData = scenario.segments[adj.segment];
    if (!segData) continue;

    const years = Object.keys(segData.annual).map(Number).sort();
    if (years.length < 2) continue;

    const baseVal = basePnL.segments[adj.segment]?.annual[years[0]];
    if (!baseVal) continue;

    for (let i = 0; i < years.length; i++) {
      segData.annual[years[i]] = baseVal * Math.pow(1 + adj.rate, i);
    }
  }

  // Remove segments
  for (const segId of adjustments.removeSegments || []) {
    if (scenario.segments[segId]) {
      for (const year of Object.keys(scenario.segments[segId].annual)) {
        scenario.segments[segId].annual[year] = 0;
      }
    }
  }

  // Cost adjustments
  for (const adj of adjustments.costAdj || []) {
    const segData = scenario.segments[adj.segment];
    if (!segData) continue;

    for (const year of Object.keys(segData.annual)) {
      if (adj.type === 'percent') {
        segData.annual[year] += Math.abs(segData.annual[year]) * adj.value;
      } else {
        segData.annual[year] += adj.value;
      }
    }
  }

  // Line-item adjustments
  for (const adj of adjustments.lineItems || []) {
    try {
      const item = resolveLineItem(gt, manifest, adj.id, dateResult);
      const delta = computeLineItemDelta(item, adj.adj);

      // Apply delta to the parent segment's totals
      const parent = adj.parent || manifest.lineItems?.[adj.id]?.parent;
      if (parent && scenario.segments[parent]) {
        for (const [year, d] of Object.entries(delta)) {
          scenario.segments[parent].annual[year] = (scenario.segments[parent].annual[year] || 0) + d;
        }
      }
    } catch (e) {
      // Skip invalid line items silently
    }
  }

  // Capitalization
  for (const adj of adjustments.capitalize || []) {
    try {
      const item = resolveLineItem(gt, manifest, adj.id, dateResult);
      const { ebitdaDelta } = computeCapitalizationDelta(item, adj.years);

      // Apply EBITDA delta (removing OpEx increases EBITDA)
      const parent = manifest.lineItems?.[adj.id]?.parent;
      if (parent && scenario.segments[parent]) {
        for (const [year, d] of Object.entries(ebitdaDelta)) {
          scenario.segments[parent].annual[year] = (scenario.segments[parent].annual[year] || 0) + d;
        }
      }
    } catch (e) {
      // Skip
    }
  }

  // Recompute totals
  const revByYear = {};
  const expByYear = {};
  for (const [id, seg] of Object.entries(scenario.segments)) {
    for (const [year, val] of Object.entries(seg.annual)) {
      const y = parseInt(year, 10);
      if (seg.type === 'revenue' || seg.type === 'profit') {
        revByYear[y] = (revByYear[y] || 0) + val;
      }
      if (seg.type === 'expense') {
        expByYear[y] = (expByYear[y] || 0) + val;
      }
    }
  }

  const ebitdaByYear = {};
  const allYears = new Set([...Object.keys(revByYear), ...Object.keys(expByYear)].map(Number));
  for (const y of allYears) {
    ebitdaByYear[y] = (revByYear[y] || 0) + (expByYear[y] || 0);
  }

  scenario.totals = {
    revenue: revByYear,
    expense: expByYear,
    ebitda: ebitdaByYear,
    ebitdaGrowth: computeGrowthRates(ebitdaByYear),
  };

  return scenario;
}

function computeTerminalValue(manifest, gt, pnl, exitYear, adjustments) {
  // Sum-of-parts mode
  if (adjustments.sotp && adjustments.segmentMultiples) {
    let tv = 0;
    for (const [segId, multiple] of Object.entries(adjustments.segmentMultiples)) {
      const segData = pnl.segments[segId];
      if (!segData) continue;
      const exitVal = segData.annual[exitYear] || 0;
      tv += Math.abs(exitVal) * multiple;
    }
    return tv;
  }

  // Revenue multiple mode
  if (adjustments.revenueMultiple) {
    const totalRev = pnl.totals.revenue[exitYear] || 0;
    return totalRev * adjustments.revenueMultiple;
  }

  // Standard EBITDA multiple
  const exitEBITDA = pnl.totals.ebitda[exitYear] || resolveBaseOutput(manifest, gt, 'exitEBITDA');
  const exitMultiple = adjustments.exitMultiple
    || (manifest.outputs?.exitMultiple?.cell ? resolveCell(gt, manifest.outputs.exitMultiple.cell) : null)
    || resolveBaseOutput(manifest, gt, 'exitMultiple');

  if (exitEBITDA && exitMultiple) {
    return exitEBITDA * exitMultiple;
  }

  // Fallback to ground truth terminal value
  return resolveBaseOutput(manifest, gt, 'terminalValue');
}

function computeExitEquity(manifest, gt, terminalValue, adjustments) {
  if (!terminalValue) return null;

  let exitDebt;
  if (adjustments.leverage !== undefined) {
    exitDebt = terminalValue * adjustments.leverage;
  } else {
    exitDebt = manifest.debt?.exitBalance ? resolveCell(gt, manifest.debt.exitBalance) : 0;
  }

  const exitCash = manifest.debt?.exitCash ? resolveCell(gt, manifest.debt.exitCash) : 0;

  // Transaction costs (if available)
  const txCostRate = manifest.customCells?.transactionCostRate
    ? resolveCell(gt, manifest.customCells.transactionCostRate) : 0;
  const txCosts = terminalValue * (txCostRate || 0);

  return terminalValue - (exitDebt || 0) + (exitCash || 0) - txCosts;
}

function buildCashFlows(equityBasis, exitEquity, holdPeriod, manifest, gt, adjustments) {
  if (!equityBasis || !exitEquity || !holdPeriod) return null;

  // Start with bullet cash flows: invest at t=0, receive at t=holdPeriod
  const cashFlows = new Array(holdPeriod + 1).fill(0);
  cashFlows[0] = -equityBasis;
  cashFlows[holdPeriod] = exitEquity;

  // Add interim distributions if specified
  for (const dist of adjustments.distributions || []) {
    const distYear = dist.year - (manifest.timeline?.investmentYear || 0);
    if (distYear > 0 && distYear < holdPeriod) {
      cashFlows[distYear] += dist.amount;
      cashFlows[holdPeriod] -= dist.amount; // Reduces exit proceeds
    }
  }

  return cashFlows;
}

function computeCarryFromWaterfall(manifest, gt, exitEquity, equityBasis, holdPeriod, adjustments) {
  if (!exitEquity || !equityBasis) return null;

  const netProceeds = exitEquity;
  const prefReturn = adjustments.prefReturn || manifest.carry?.waterfall?.prefReturn || 0.08;
  const carryRate = manifest.carry?.waterfall?.carryRate || 0.20;

  const tiers = createAmericanWaterfall({
    prefReturn,
    carryPercent: carryRate,
    residualLPSplit: 1 - carryRate,
    hasCatchup: manifest.carry?.waterfall?.catchUpType !== 'none',
  });

  return computeWaterfall(netProceeds, equityBasis, tiers, {
    holdPeriodYears: holdPeriod,
    compoundHurdles: true,
  });
}

function resolveBaseOutput(manifest, gt, key) {
  // Check baseCaseOutputs first
  if (manifest.baseCaseOutputs?.[key] !== undefined) {
    return manifest.baseCaseOutputs[key];
  }

  // Try resolving from ground truth
  const cellMap = {
    exitEBITDA: manifest.outputs?.ebitda?.exitValue,
    terminalValue: manifest.outputs?.terminalValue?.cell,
    exitMultiple: manifest.outputs?.exitMultiple?.cell,
    equityBasis: manifest.equity?.classes?.[0]?.basisCell,
    grossMOIC: manifest.equity?.classes?.[0]?.grossMOIC,
    grossIRR: manifest.equity?.classes?.[0]?.grossIRR,
    netMOIC: manifest.equity?.classes?.[0]?.netMOIC,
    netIRR: manifest.equity?.classes?.[0]?.netIRR,
    totalCarry: manifest.carry?.totalCell,
  };

  const cellRef = cellMap[key];
  if (cellRef) return resolveCell(gt, cellRef);

  return null;
}

// ---------------------------------------------------------------------------
// Adjustment flattening for attribution
// ---------------------------------------------------------------------------

function flattenAdjustments(adjustments) {
  const flat = {};

  if (adjustments.exitYear) flat['exit-year'] = adjustments.exitYear;
  if (adjustments.exitMultiple) flat['exit-multiple'] = adjustments.exitMultiple;
  if (adjustments.revenueMultiple) flat['revenue-multiple'] = adjustments.revenueMultiple;
  if (adjustments.leverage !== undefined) flat['leverage'] = adjustments.leverage;
  if (adjustments.holdPeriod) flat['hold-period'] = adjustments.holdPeriod;
  if (adjustments.prefReturn) flat['pref-return'] = adjustments.prefReturn;
  if (adjustments.equityOverride) flat['equity-override'] = adjustments.equityOverride;

  for (const adj of adjustments.revenueAdj || []) {
    flat[`revenue-adj:${adj.segment}`] = adj;
  }
  for (const adj of adjustments.revenueGrowth || []) {
    flat[`revenue-growth:${adj.segment}`] = adj;
  }
  for (const adj of adjustments.costAdj || []) {
    flat[`cost-adj:${adj.segment}`] = adj;
  }
  for (const id of adjustments.removeSegments || []) {
    flat[`remove-segment:${id}`] = id;
  }
  for (const adj of adjustments.lineItems || []) {
    flat[`line-item:${adj.id}`] = adj;
  }

  return flat;
}

function unflattenAdjustment(key, value) {
  if (key === 'exit-year') return { exitYear: value };
  if (key === 'exit-multiple') return { exitMultiple: value };
  if (key === 'revenue-multiple') return { revenueMultiple: value };
  if (key === 'leverage') return { leverage: value };
  if (key === 'hold-period') return { holdPeriod: value };
  if (key === 'pref-return') return { prefReturn: value };
  if (key === 'equity-override') return { equityOverride: value };

  if (key.startsWith('revenue-adj:')) return { revenueAdj: [value] };
  if (key.startsWith('revenue-growth:')) return { revenueGrowth: [value] };
  if (key.startsWith('cost-adj:')) return { costAdj: [value] };
  if (key.startsWith('remove-segment:')) return { removeSegments: [value] };
  if (key.startsWith('line-item:')) return { lineItems: [value] };

  return {};
}
