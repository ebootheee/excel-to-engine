/**
 * ete scenario — Run scenario analysis.
 *
 * Applies adjustments to base case via the delta cascade
 * and computes resulting returns.
 *
 * @license MIT
 */

import { runScenario, listSavedScenarios } from '../solvers/scenario-engine.mjs';
import { formatOutput } from '../format.mjs';

/**
 * Execute the scenario command.
 */
export function runScenarioCommand(modelDir, args) {
  // List saved scenarios
  if (args.list) {
    const saved = listSavedScenarios(modelDir);
    if (saved.length === 0) return { _formatted: 'No saved scenarios.' };

    const lines = ['Saved scenarios:'];
    for (const s of saved) {
      const irr = s.summary?.grossIRR ? `IRR=${(s.summary.grossIRR * 100).toFixed(1)}%` : '';
      const moic = s.summary?.grossMOIC ? `MOIC=${s.summary.grossMOIC.toFixed(2)}x` : '';
      lines.push(`  ${s.name}  ${irr}  ${moic}`);
    }
    return { saved, _formatted: lines.join('\n') };
  }

  const result = runScenario(modelDir, args);

  // Format based on requested format
  if (args.format === 'json') {
    const { _formatted, ...data } = result;
    return { ...data, _formatted: JSON.stringify(data, null, 2) };
  }

  return result;
}
