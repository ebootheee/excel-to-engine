#!/usr/bin/env node

/**
 * ete — excel-to-engine CLI
 *
 * Scenario analysis, sensitivity surfaces, and financial queries
 * against any converted Excel model.
 *
 * Usage:
 *   ete init model.xlsx [--output ./dir]
 *   ete summary ./model/
 *   ete query ./model/ "Sheet!A1" | --search "term" | --name key
 *   ete pnl ./model/ [--segment id] [--detail] [--growth]
 *   ete scenario ./model/ [--exit-multiple 16] [--file scenario.json] [--save name]
 *   ete sensitivity ./model/ --vary param:min-max:step [--metric irr,moic]
 *   ete compare ./model/ --base "" --alt "params" [--attribution]
 *   ete manifest generate|validate <path>
 *
 * @license MIT
 */

import { formatOutput } from './format.mjs';

const COMMANDS = {
  init: { desc: 'Parse Excel + generate manifest', module: './commands/init.mjs' },
  summary: { desc: 'One-shot model overview', module: './commands/summary.mjs' },
  query: { desc: 'Query ground truth cells', module: './commands/query.mjs' },
  pnl: { desc: 'Extract annual P&L by segment', module: './commands/pnl.mjs' },
  scenario: { desc: 'Run scenario analysis', module: './commands/scenario.mjs' },
  sensitivity: { desc: 'Generate sensitivity surface', module: './commands/sensitivity.mjs' },
  compare: { desc: 'Compare scenarios or models', module: './commands/compare.mjs' },
  carry: { desc: 'Compute GP carry under a waterfall', module: './commands/carry.mjs' },
  extract: { desc: 'Pull time-series schedules from the model', module: './commands/extract.mjs' },
  explain: { desc: 'Audit trail for a manifest name or cell', module: './commands/explain.mjs' },
  eval: { desc: 'Evaluate a cell via the chunked engine', module: './commands/eval.mjs' },
  manifest: { desc: 'Generate or validate manifest', module: './commands/manifest.mjs' },
};

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // --compact is shorthand for --format compact (AI consumer mode)
  if (args.compact && !args.format) args.format = 'compact';

  if (args.help || args._.length === 0) {
    printHelp();
    process.exit(0);
  }

  const command = args._[0];
  const handler = COMMANDS[command];

  if (!handler) {
    console.error(`Unknown command: ${command}\n`);
    printHelp();
    process.exit(1);
  }

  try {
    const mod = await import(handler.module);
    let result;

    switch (command) {
      case 'init': {
        const { runInit } = mod;
        result = runInit(args._[1], args);
        break;
      }
      case 'summary': {
        const { runSummary } = mod;
        result = runSummary(args._[1], args);
        break;
      }
      case 'query': {
        const { runQuery } = mod;
        result = runQuery(args._[1], { ...args, cells: args._.slice(2) });
        break;
      }
      case 'pnl': {
        const { runPnl } = mod;
        result = runPnl(args._[1], args);
        break;
      }
      case 'scenario': {
        const { runScenarioCommand } = mod;
        result = runScenarioCommand(args._[1], args);
        break;
      }
      case 'sensitivity': {
        const { runSensitivityCommand } = mod;
        result = runSensitivityCommand(args._[1], args);
        break;
      }
      case 'compare': {
        const { runCompareCommand } = mod;
        result = runCompareCommand(args._[1], args);
        break;
      }
      case 'carry': {
        const { runCarryCommand } = mod;
        result = runCarryCommand(args._[1], args);
        break;
      }
      case 'extract': {
        const { runExtract } = mod;
        result = runExtract(args._[1], args);
        break;
      }
      case 'explain': {
        const { runExplain } = mod;
        result = runExplain(args._[1], args._[2], args);
        break;
      }
      case 'eval': {
        const { runEval } = mod;
        result = await runEval(args._[1], { ...args, cells: args._.slice(2) });
        break;
      }
      case 'manifest': {
        const { runManifestCommand } = mod;
        // ete manifest <subcommand> <path> [extraArgs...]
        // args._[0]="manifest", args._[1]=subcommand, args._[2]=path, args._[3..]=extra
        result = runManifestCommand(args._[1], args._[2], args, args._.slice(3));
        break;
      }
    }

    // Output result
    if (result) {
      if (result.error) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      const output = args.format && args.format !== 'table'
        ? formatOutput(result, args.format)
        : result._formatted || formatOutput(result, 'json');

      console.log(output);
    }

  } catch (err) {
    console.error(`Error: ${err.message}`);
    if (args.verbose) console.error(err.stack);
    process.exit(1);
  }
}

/**
 * Minimal argument parser (no dependencies).
 * Supports: --flag, --key value, --key=value, positional args
 */
function parseArgs(argv) {
  const result = { _: [] };
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '--') {
      result._.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 0) {
        const key = camelCase(arg.substring(2, eqIdx));
        result[key] = arg.substring(eqIdx + 1);
      } else {
        const key = camelCase(arg.substring(2));
        const next = argv[i + 1];

        if (!next || next.startsWith('--')) {
          result[key] = true;
        } else {
          // Support repeated flags (--vary x --vary y)
          if (result[key] !== undefined) {
            if (!Array.isArray(result[key])) result[key] = [result[key]];
            result[key].push(next);
          } else {
            result[key] = next;
          }
          i++;
        }
      }
    } else {
      result._.push(arg);
    }

    i++;
  }

  return result;
}

function camelCase(str) {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function printHelp() {
  console.log(`
ete — excel-to-engine CLI

Commands:
  init <model.xlsx>          Parse Excel model + generate manifest
                             Flags: --output <dir>, --template <name>, --no-template,
                                    --strict (hard-fail on doctor errors),
                                    --reuse-parse (skip Rust parse if chunked/ exists)
  summary <modelDir>         One-shot model overview (--terse to hide suspects)
  query <modelDir> [args]    Query ground truth cells
  pnl <modelDir>             Extract annual P&L by segment
  scenario <modelDir>        Run scenario analysis
  sensitivity <modelDir>     Generate sensitivity surface
  compare <modelDir>         Compare scenarios or models
  carry [modelDir]           Compute GP carry under a waterfall
  manifest <sub> <path>      generate | validate | refine | doctor | set

Query modes (add --sheet "Name" to restrict scope and speed up 10-50×):
  ete query ./m/ "Sheet!A1"                      Cell lookup
  ete query ./m/ --search "revenue"              Label search (literal substring, case-insensitive)
  ete query ./m/ --search "revenue" --case H     Prefer column H's value (scenario columns)
  ete query ./m/ --search "Gross.*IRR" --regex   Opt in to regex
  ete query ./m/ --name exitMultiple             Manifest name

Carry flags (falls back to manifest values when not provided):
  --peak <dollars>           Peak equity committed
  --moc <multiple>           Gross MoC (2.8 = 2.8×)
  --life <years>             Hold period
  --irr <rate>               IRR, used to solve hold: n = ln(MoC)/ln(1+IRR)
  --pref <rate>              Preferred return (0.08 = 8%)
  --carry <rate>             GP carry percent (0.20 = 20%)
  --ownership <frac>         Your share of GP carry (0.06 = 6%)
  --structure <a|e>          american | european waterfall (IRR-based hurdles)
  --hurdle-moic <n>          Flat MOIC hurdle (e.g., 1.40). No IRR pref, does
                             not compound with hold. Overrides --structure.
                             Common in VC Class A PPS waterfalls.
  --combined                 Sum all equity classes (for multi-class funds)

Scenario flags:
  --exit-year <year>                 Override exit year
  --exit-multiple <n>                Override EBITDA multiple
  --revenue-adj <seg>:<+/-pct/$>     Adjust segment revenue
  --revenue-growth <seg>:<rate>      Override growth rate
  --cost-adj <seg>:<+/-pct/$>        Adjust segment costs
  --line-item <id>:<adj>             Row-level adjustment
  --capitalize <id>:<years>          Reclassify OpEx as CapEx
  --leverage <ltv>                   Override exit LTV
  --distribution <year>:<amount>     Add interim distribution
  --segment-multiple <seg>:<n>       Per-segment exit multiple
  --sotp                             Sum-of-parts valuation
  --file <path>                      Load from scenario file
  --save <name>                      Save scenario
  --load <name>                      Load saved scenario

Sensitivity:
  --vary <param>:<min>-<max>:<step>  Sweep parameter (1D or 2D)
  --metric <list>                    Output metrics (irr,moic,carry)

Compare:
  --base "" --alt "key=val,..."      Base vs scenario
  --scenarios "name1,name2,..."      Named scenario comparison
  --models ./a/ ./b/                 Cross-model comparison
  --attribution                      Decompose delta into drivers

Global flags:
  --format <table|json|csv|md>       Output format (default: table)
  --help                             Show this help
  --verbose                          Show stack traces
`.trim());
}

main();
