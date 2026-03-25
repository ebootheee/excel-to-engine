/**
 * excel-to-engine — Dashboard Application
 *
 * Auto-populates from model-map.json and engine.js.
 * No build step required — open index.html in a browser.
 *
 * Template placeholders:
 *   {{ENGINE_PATH}}    — Path to the generated engine.js
 *   {{MODEL_MAP_PATH}} — Path to model-map.json
 *   {{EVAL_DATA_PATH}} — Path to eval results JSON (optional)
 *
 * @license MIT
 */

// ---------------------------------------------------------------------------
// Configuration — replaced by the generator
// ---------------------------------------------------------------------------

const ENGINE_PATH = '{{ENGINE_PATH}}';       // e.g., '../../engine.js'
const MODEL_MAP_PATH = '{{MODEL_MAP_PATH}}'; // e.g., '../../model-map.json'
const EVAL_DATA_PATH = '{{EVAL_DATA_PATH}}'; // e.g., '../../tests/eval-results.json'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let engine = null;          // { computeModel, BASE_CASE }
let modelMap = null;        // Parsed model-map.json
let evalData = null;        // Parsed eval results
let currentInputs = {};     // Current slider values
let baseCaseResult = null;  // Result at base case

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

async function init() {
  try {
    // Load engine module
    engine = await import(ENGINE_PATH);
    currentInputs = { ...engine.BASE_CASE };
    baseCaseResult = engine.computeModel(engine.BASE_CASE);

    // Load model map
    const mapResp = await fetch(MODEL_MAP_PATH);
    modelMap = await mapResp.json();

    // Try loading eval results (optional)
    try {
      const evalResp = await fetch(EVAL_DATA_PATH);
      if (evalResp.ok) evalData = await evalResp.json();
    } catch { /* eval data is optional */ }

    // Set title
    document.getElementById('modelTitle').textContent = modelMap.modelName || 'Model Dashboard';
    document.getElementById('modelSubtitle').textContent =
      `Generated ${modelMap.generatedAt ? new Date(modelMap.generatedAt).toLocaleDateString() : ''} — excel-to-engine`;

    // Build UI
    buildOutputCards();
    buildInputSliders();
    buildSensitivityControls();
    updateAll();

    if (evalData) {
      buildEvalTab();
    }

  } catch (err) {
    console.error('Dashboard init failed:', err);
    document.body.innerHTML = `
      <div class="max-w-xl mx-auto mt-20 p-8 text-center">
        <h1 class="text-xl font-semibold text-red-600 mb-4">Dashboard Load Error</h1>
        <p class="text-slate-600 mb-4">Could not load the engine or model map. Make sure the paths are correct:</p>
        <pre class="text-left bg-slate-100 p-4 rounded-lg text-sm overflow-x-auto">${err.message}</pre>
        <p class="text-slate-500 mt-4 text-sm">Engine: ${ENGINE_PATH}<br>Model Map: ${MODEL_MAP_PATH}</p>
      </div>`;
  }
}

// ---------------------------------------------------------------------------
// Tab Navigation
// ---------------------------------------------------------------------------

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden');
  });
});

// Reset button
document.getElementById('resetBtn')?.addEventListener('click', () => {
  if (!engine) return;
  currentInputs = { ...engine.BASE_CASE };
  document.querySelectorAll('.input-slider').forEach(slider => {
    const key = slider.dataset.key;
    slider.value = currentInputs[key];
    updateSliderDisplay(key, currentInputs[key]);
  });
  updateAll();
});

// ---------------------------------------------------------------------------
// Output Cards
// ---------------------------------------------------------------------------

function buildOutputCards() {
  const container = document.getElementById('outputCards');
  if (!modelMap?.outputs) return;

  // Show key outputs as cards
  const keyOutputs = modelMap.outputs.slice(0, 8); // Show up to 8 cards
  container.innerHTML = keyOutputs.map(out => `
    <div class="output-card" data-key="${out.name}">
      <div class="label">${out.name}</div>
      <div class="value" id="card-${slugify(out.name)}">—</div>
      <div class="delta neutral" id="delta-${slugify(out.name)}">Base case</div>
    </div>
  `).join('');
}

function updateOutputCards(result) {
  if (!modelMap?.outputs) return;

  const keyOutputs = modelMap.outputs.slice(0, 8);
  for (const out of keyOutputs) {
    const slug = slugify(out.name);
    const el = document.getElementById(`card-${slug}`);
    const deltaEl = document.getElementById(`delta-${slug}`);
    if (!el) continue;

    const value = getNestedValue(result, out.key || out.name);
    const baseValue = out.baseCase;

    el.textContent = formatValue(value, out.format || out.type);

    if (baseValue != null && value != null && Math.abs(baseValue) > 1e-12) {
      const pctChange = ((value - baseValue) / Math.abs(baseValue)) * 100;
      const sign = pctChange > 0 ? '+' : '';
      deltaEl.textContent = `${sign}${pctChange.toFixed(1)}% vs base`;
      deltaEl.className = `delta ${pctChange > 0.1 ? 'positive' : pctChange < -0.1 ? 'negative' : 'neutral'}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Input Sliders
// ---------------------------------------------------------------------------

function buildInputSliders() {
  const container = document.getElementById('inputSliders');
  if (!modelMap?.inputs) return;

  container.innerHTML = modelMap.inputs.map(inp => {
    const [min, max] = inp.range || [inp.baseCase * 0.5, inp.baseCase * 2.0];
    const step = computeStep(min, max, inp.baseCase);
    return `
      <div class="input-group">
        <label>
          <span>${inp.name}</span>
          <span class="value-display" id="display-${slugify(inp.name)}">${formatValue(inp.baseCase, inp.format || inp.type)}</span>
        </label>
        <input type="range"
               class="input-slider"
               data-key="${inp.name}"
               min="${min}" max="${max}" step="${step}"
               value="${inp.baseCase}" />
      </div>
    `;
  }).join('');

  // Attach event listeners
  container.querySelectorAll('.input-slider').forEach(slider => {
    slider.addEventListener('input', (e) => {
      const key = e.target.dataset.key;
      const val = parseFloat(e.target.value);
      currentInputs[key] = val;

      const inp = modelMap.inputs.find(i => i.name === key);
      updateSliderDisplay(key, val, inp?.format || inp?.type);
      updateAll();
    });
  });
}

function updateSliderDisplay(key, value, format) {
  const el = document.getElementById(`display-${slugify(key)}`);
  if (el) el.textContent = formatValue(value, format);
}

// ---------------------------------------------------------------------------
// Sensitivity Heatmap
// ---------------------------------------------------------------------------

function buildSensitivityControls() {
  if (!modelMap?.inputs || !modelMap?.outputs) return;

  const sel1 = document.getElementById('sensInput1');
  const sel2 = document.getElementById('sensInput2');
  const selOut = document.getElementById('sensOutput');

  modelMap.inputs.forEach((inp, i) => {
    sel1.add(new Option(inp.name, inp.name, i === 0, i === 0));
    sel2.add(new Option(inp.name, inp.name, i === 1, i === 1));
  });

  modelMap.outputs.forEach((out, i) => {
    selOut.add(new Option(out.name, out.name, i === 0, i === 0));
  });

  [sel1, sel2, selOut].forEach(sel =>
    sel.addEventListener('change', () => updateSensitivity())
  );
}

function updateSensitivity() {
  if (!engine || !modelMap) return;

  const input1Name = document.getElementById('sensInput1').value;
  const input2Name = document.getElementById('sensInput2').value;
  const outputName = document.getElementById('sensOutput').value;

  const inp1 = modelMap.inputs.find(i => i.name === input1Name);
  const inp2 = modelMap.inputs.find(i => i.name === input2Name);
  const out = modelMap.outputs.find(o => o.name === outputName);
  if (!inp1 || !inp2 || !out) return;

  const steps = 5;
  const vals1 = linspace(inp1.range?.[0] ?? inp1.baseCase * 0.5, inp1.range?.[1] ?? inp1.baseCase * 2.0, steps);
  const vals2 = linspace(inp2.range?.[0] ?? inp2.baseCase * 0.5, inp2.range?.[1] ?? inp2.baseCase * 2.0, steps);

  const grid = [];
  let allValues = [];

  for (const v2 of vals2) {
    const row = [];
    for (const v1 of vals1) {
      const testInputs = { ...currentInputs, [input1Name]: v1, [input2Name]: v2 };
      const result = engine.computeModel(testInputs);
      const val = getNestedValue(result, out.key || out.name);
      row.push(val);
      if (val != null) allValues.push(val);
    }
    grid.push(row);
  }

  // Render heatmap table
  const table = document.getElementById('heatmapTable');
  const minVal = Math.min(...allValues);
  const maxVal = Math.max(...allValues);

  let html = `<tr class="header-row"><th></th>`;
  for (const v1 of vals1) {
    html += `<th>${formatValue(v1, inp1.format || inp1.type)}</th>`;
  }
  html += `</tr>`;

  for (let i = 0; i < vals2.length; i++) {
    html += `<tr><td class="row-header">${formatValue(vals2[i], inp2.format || inp2.type)}</td>`;
    for (let j = 0; j < vals1.length; j++) {
      const val = grid[i][j];
      const heatClass = getHeatClass(val, minVal, maxVal);
      html += `<td class="${heatClass}">${formatValue(val, out.format || out.type)}</td>`;
    }
    html += `</tr>`;
  }

  table.innerHTML = html;
}

function getHeatClass(value, min, max) {
  if (value == null || min === max) return 'heat-2';
  const normalized = (value - min) / (max - min);
  // Higher values = greener (better for returns)
  if (normalized >= 0.8) return 'heat-0';
  if (normalized >= 0.6) return 'heat-1';
  if (normalized >= 0.4) return 'heat-2';
  if (normalized >= 0.2) return 'heat-3';
  return 'heat-4';
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

let cashFlowChartInstance = null;
let waterfallChartInstance = null;

function updateCharts(result) {
  updateCashFlowChart(result);
  updateWaterfallChart(result);
}

function updateCashFlowChart(result) {
  const ctx = document.getElementById('cashFlowChart');
  if (!ctx) return;

  const cf = result.equityCashFlows;
  if (!cf?.years?.length) return;

  if (cashFlowChartInstance) cashFlowChartInstance.destroy();

  cashFlowChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: cf.years.map(y => `Year ${y}`),
      datasets: [
        {
          label: 'Draws',
          data: cf.draws || [],
          backgroundColor: '#ef4444',
        },
        {
          label: 'Distributions',
          data: cf.distributions || [],
          backgroundColor: '#22c55e',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { position: 'top' },
      },
      scales: {
        y: {
          ticks: {
            callback: v => formatCurrencyShort(v),
          },
        },
      },
    },
  });
}

function updateWaterfallChart(result) {
  const ctx = document.getElementById('waterfallChart');
  if (!ctx) return;

  const wf = result.waterfall;
  if (!wf?.tiers?.length) return;

  if (waterfallChartInstance) waterfallChartInstance.destroy();

  const tiers = wf.tiers.filter(t => t.distributed > 0);

  waterfallChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: tiers.map(t => t.name),
      datasets: [
        {
          label: 'LP',
          data: tiers.map(t => t.lpAmount),
          backgroundColor: '#3b82f6',
        },
        {
          label: 'GP',
          data: tiers.map(t => t.gpAmount),
          backgroundColor: '#f59e0b',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { position: 'top' },
      },
      scales: {
        x: { stacked: true },
        y: {
          stacked: true,
          ticks: {
            callback: v => formatCurrencyShort(v),
          },
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Eval Tab
// ---------------------------------------------------------------------------

function buildEvalTab() {
  if (!evalData) return;

  // Summary banner
  const summary = document.getElementById('evalSummary');
  const passCount = evalData.baseCaseResults?.filter(r => r.passed).length || 0;
  const totalCount = evalData.baseCaseResults?.length || 0;
  const allPassed = passCount === totalCount;

  summary.className = `rounded-xl p-6 mb-8 border ${allPassed ? 'eval-pass' : 'eval-fail'}`;
  summary.innerHTML = `
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-lg font-semibold">${allPassed ? 'All Tests Passed' : 'Some Tests Failed'}</h2>
        <p class="text-sm mt-1">${passCount}/${totalCount} base case checks passed | Tolerance: ${((evalData.tolerance || 0.01) * 100).toFixed(1)}%</p>
      </div>
      <span class="status-badge ${allPassed ? 'pass' : 'fail'}">${allPassed ? 'PASS' : 'FAIL'}</span>
    </div>
  `;

  // Base case table
  if (evalData.baseCaseResults) {
    const tbody = document.getElementById('baseCaseBody');
    tbody.innerHTML = evalData.baseCaseResults.map(r => `
      <tr class="border-b border-slate-100">
        <td class="py-2 px-3 font-medium">${r.key}</td>
        <td class="py-2 px-3 text-right font-mono">${formatValue(r.expected)}</td>
        <td class="py-2 px-3 text-right font-mono">${formatValue(r.actual)}</td>
        <td class="py-2 px-3 text-right font-mono">${r.deviationPercent || (r.deviation * 100).toFixed(4) + '%'}</td>
        <td class="py-2 px-3 text-center">
          <span class="status-badge ${r.passed ? 'pass' : 'fail'}">${r.passed ? 'PASS' : 'FAIL'}</span>
        </td>
      </tr>
    `).join('');
  }

  // Deviation chart
  if (evalData.baseCaseResults) {
    const ctx = document.getElementById('deviationChart');
    new Chart(ctx, {
      type: 'bar',
      data: {
        labels: evalData.baseCaseResults.map(r => r.key),
        datasets: [{
          label: 'Deviation (%)',
          data: evalData.baseCaseResults.map(r => (r.deviation || 0) * 100),
          backgroundColor: evalData.baseCaseResults.map(r =>
            r.passed ? '#22c55e' : '#ef4444'
          ),
        }],
      },
      options: {
        responsive: true,
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: {
          x: {
            title: { display: true, text: 'Deviation (%)' },
          },
        },
      },
    });
  }

  // Monotonicity results
  if (evalData.monotonicityResults) {
    const container = document.getElementById('monotonicityResults');
    container.innerHTML = evalData.monotonicityResults.map(r => `
      <div class="check-row ${r.passed ? 'pass' : 'fail'}">
        <span class="check-icon">${r.passed ? '\u2705' : '\u274C'}</span>
        <span>${r.description}</span>
      </div>
    `).join('');
  }

  // Consistency results
  if (evalData.consistencyResults) {
    const container = document.getElementById('consistencyResults');
    container.innerHTML = evalData.consistencyResults.map(r => `
      <div class="check-row ${r.passed ? 'pass' : 'fail'}">
        <span class="check-icon">${r.passed ? '\u2705' : '\u274C'}</span>
        <span>${r.description}</span>
        ${!r.passed ? `<span class="text-red-600 text-sm ml-auto">${r.detail || ''}</span>` : ''}
      </div>
    `).join('');
  }
}

// ---------------------------------------------------------------------------
// Update Loop
// ---------------------------------------------------------------------------

function updateAll() {
  if (!engine) return;
  const result = engine.computeModel(currentInputs);
  updateOutputCards(result);
  updateCharts(result);
  updateSensitivity();
}

// ---------------------------------------------------------------------------
// Formatting Utilities
// ---------------------------------------------------------------------------

function formatValue(value, format) {
  if (value == null || isNaN(value)) return '\u2014';
  switch (format) {
    case 'currency':
    case 'dollar':
      return '$' + Math.round(value).toLocaleString('en-US');
    case 'percent':
    case 'percentage':
      return (value * 100).toFixed(2) + '%';
    case 'multiple':
    case 'moic':
      return value.toFixed(2) + 'x';
    case 'integer':
      return Math.round(value).toLocaleString('en-US');
    default:
      if (Math.abs(value) >= 1000) return Math.round(value).toLocaleString('en-US');
      if (Math.abs(value) < 0.1 && value !== 0) return (value * 100).toFixed(2) + '%';
      return value.toFixed(2);
  }
}

function formatCurrencyShort(value) {
  if (value == null) return '';
  const abs = Math.abs(value);
  if (abs >= 1e9) return '$' + (value / 1e9).toFixed(1) + 'B';
  if (abs >= 1e6) return '$' + (value / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return '$' + (value / 1e3).toFixed(0) + 'K';
  return '$' + value.toFixed(0);
}

function slugify(str) {
  return str.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').toLowerCase();
}

function getNestedValue(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((curr, key) => curr?.[key], obj);
}

function linspace(start, end, n) {
  const step = (end - start) / (n - 1);
  return Array.from({ length: n }, (_, i) => start + step * i);
}

function computeStep(min, max, base) {
  const range = max - min;
  if (range === 0) return 1;
  // ~200 steps for smooth sliding
  const rawStep = range / 200;
  // Round to a nice number
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  return Math.max(magnitude, rawStep);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

init();
