import { runtime } from './runtime'
import { KPI_META, type ExperimentResult, type ExperimentSummary } from './sim/experiment'
import { scenarioById } from './sim/scenarios'
import type { SimParams } from './sim/types'
import { useUI, type LabRun } from './store'

export type KpiKey = keyof typeof KPI_META
export const LAB_KPIS: KpiKey[] = ['speed', 'congestion', 'trip', 'throughput', 'co2', 'power', 'response', 'removed']

export interface KpiRow {
  key: KpiKey
  label: string
  unit: string
  a: number
  b: number
  sdA: number
  sdB: number
  delta: number
  better: boolean | null
  consistent: boolean
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1)
const sd = (xs: number[]) => {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))
}

/** Runs A and B with common random numbers (identical seeds per replicate), so the
 *  difference measures the intervention rather than random variation. */
export async function runAB(opts: {
  scenarioId: string; a: SimParams; b: SimParams; labelA: string; labelB: string; duration: number; reps: number
  onProgress?: (p: number, label: string) => void
}): Promise<LabRun> {
  const events = runtime.scenarioEvents(opts.scenarioId)
  const specs = []
  for (let r = 0; r < opts.reps; r++) {
    specs.push({ label: `${opts.labelA} · seed ${opts.a.seed + r}`, params: { ...opts.a, seed: opts.a.seed + r }, events, duration: opts.duration })
    specs.push({ label: `${opts.labelB} · seed ${opts.a.seed + r}`, params: { ...opts.b, seed: opts.a.seed + r }, events, duration: opts.duration })
  }
  const results = await runtime.runExperiments(specs, opts.onProgress)
  const run: LabRun = {
    id: Date.now(), scenario: opts.scenarioId, city: runtime.city.id, labelA: opts.labelA, labelB: opts.labelB, duration: opts.duration, createdAt: Date.now(),
    a: results.filter((_, i) => i % 2 === 0), b: results.filter((_, i) => i % 2 === 1),
  }
  return run
}

export function compare(run: LabRun, keys: KpiKey[] = LAB_KPIS): KpiRow[] {
  return keys.map((key) => {
    const meta = KPI_META[key]
    const va = run.a.map((r) => r.summary[key as keyof ExperimentSummary] as number)
    const vb = run.b.map((r) => r.summary[key as keyof ExperimentSummary] as number)
    const a = mean(va)
    const b = mean(vb)
    const delta = a === 0 ? (b === 0 ? 0 : 1) : (b - a) / Math.abs(a)
    // a KPI that one arm never observed (e.g. no emergencies happened) cannot be compared
    const tiny = Math.abs(b - a) < 1e-6 || Math.abs(delta) < 0.005 || (key === 'response' && (a === 0 || b === 0))
    const better = tiny ? null : meta.better === 'up' ? b > a : b < a
    const consistent = va.every((x, i) => (meta.better === 'up' ? vb[i] >= x : vb[i] <= x)) || va.every((x, i) => (meta.better === 'up' ? vb[i] <= x : vb[i] >= x))
    return { key, label: meta.label, unit: meta.unit, a, b, sdA: sd(va), sdB: sd(vb), delta, better, consistent }
  })
}

export function fmtKpi(key: KpiKey, v: number) {
  return KPI_META[key].fmt(v)
}

/** A plain-language verdict built only from the measured deltas. */
export function verdict(run: LabRun): { winner: 'A' | 'B' | 'tie'; text: string; score: number } {
  const rows = compare(run).filter((r) => r.better !== null)
  const weights: Partial<Record<KpiKey, number>> = { congestion: 3, trip: 2, speed: 2, throughput: 1.5, response: 2.5, power: 2, removed: 1.5, co2: 1 }
  let score = 0
  for (const r of rows) score += (r.better ? 1 : -1) * (weights[r.key] ?? 1) * Math.min(1, Math.abs(r.delta) * 5)
  const wins = rows.filter((r) => r.better).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
  const losses = rows.filter((r) => r.better === false).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
  const winner = Math.abs(score) < 0.4 ? 'tie' : score > 0 ? 'B' : 'A'
  const pct = (r: KpiRow) => `${r.label.toLowerCase()} ${r.delta > 0 ? '+' : ''}${(r.delta * 100).toFixed(1)}%`
  let text: string
  if (winner === 'tie') text = `No meaningful difference: "${run.labelB}" and "${run.labelA}" perform within noise on the weighted KPIs.`
  else if (winner === 'B') text = `"${run.labelB}" outperforms the baseline: ${wins.slice(0, 3).map(pct).join(', ')}${losses.length ? `. Trade-off: ${losses.slice(0, 2).map(pct).join(', ')}` : ''}.`
  else text = `"${run.labelB}" makes things worse: ${losses.slice(0, 3).map(pct).join(', ')}${wins.length ? `. It does improve ${wins.slice(0, 2).map(pct).join(', ')}` : ''}.`
  return { winner, text, score }
}

export function seriesOf(results: ExperimentResult[], key: 'speed' | 'congestion' | 'throughput' | 'co2' | 'power') {
  if (!results.length) return []
  const n = Math.min(...results.map((r) => r.history.length))
  const out: { t: number; v: number }[] = []
  for (let i = 0; i < n; i++) {
    const v = mean(results.map((r) => r.history[i][key]))
    out.push({ t: results[0].history[i].t, v: key === 'congestion' || key === 'power' ? v * 100 : v })
  }
  return out
}

// ───────────────────────────── persistence & sharing
const KEY = 'synapse.lab.runs.v1'

export function saveRuns(runs: LabRun[]) {
  try {
    const light = runs.slice(-6).map((r) => ({ ...r, a: r.a.map(stripHistory), b: r.b.map(stripHistory) }))
    localStorage.setItem(KEY, JSON.stringify(light))
  } catch { /* storage unavailable or full */ }
}

function stripHistory(r: ExperimentResult): ExperimentResult {
  return { ...r, history: r.history.filter((_, i) => i % 3 === 0) }
}

export function loadRuns(): LabRun[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]')
  } catch {
    return []
  }
}

export interface SharedSetup {
  scenario: string
  a: SimParams
  b: SimParams
  labelB: string
  duration: number
  reps: number
}

export function shareLink(s: SharedSetup) {
  const enc = btoa(unescape(encodeURIComponent(JSON.stringify(s))))
  return `${location.origin}${location.pathname}#lab=${enc}`
}

export function readSharedSetup(): SharedSetup | null {
  const m = location.hash.match(/#lab=(.+)$/)
  if (!m) return null
  try {
    return JSON.parse(decodeURIComponent(escape(atob(m[1]))))
  } catch {
    return null
  }
}

export function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function exportCsv(run: LabRun) {
  const rows = compare(run)
  const lines = ['kpi,unit,baseline_mean,baseline_sd,intervention_mean,intervention_sd,delta_pct,better']
  for (const r of rows) lines.push([r.label, r.unit, r.a.toFixed(4), r.sdA.toFixed(4), r.b.toFixed(4), r.sdB.toFixed(4), (r.delta * 100).toFixed(2), r.better ?? 'equal'].join(','))
  lines.push('', 'replicate,arm,seed,' + LAB_KPIS.join(','))
  for (const [arm, rs] of [['A', run.a], ['B', run.b]] as const) {
    rs.forEach((r, i) => lines.push([i + 1, arm, r.seed, ...LAB_KPIS.map((k) => (r.summary[k as keyof ExperimentSummary] as number).toFixed(4))].join(',')))
  }
  download(`synapse-${run.scenario}-${run.id}.csv`, lines.join('\n'), 'text/csv')
}

export function exportJson(run: LabRun) {
  download(`synapse-${run.scenario}-${run.id}.json`, JSON.stringify({ ...run, comparison: compare(run), verdict: verdict(run) }, null, 2), 'application/json')
}

/** Printable executive report generated from the experiment data. */
export function openReport(run: LabRun) {
  const sc = scenarioById(run.scenario)
  const rows = compare(run)
  const v = verdict(run)
  const p = run.a[0].params
  const diff = Object.entries(run.b[0].params).filter(([k, val]) => (p as unknown as Record<string, unknown>)[k] !== val && k !== 'seed')
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>SYNAPSE report · ${sc?.name}</title>
  <style>body{font-family:Inter,Segoe UI,system-ui,sans-serif;max-width:820px;margin:40px auto;color:#0f172a;line-height:1.55;padding:0 20px}
  h1{font-size:26px;margin:0}h2{font-size:14px;letter-spacing:.12em;text-transform:uppercase;color:#0e7490;margin-top:28px}
  .tag{color:#64748b;font-size:13px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:7px 8px;border-bottom:1px solid #e2e8f0;text-align:right}
  th:first-child,td:first-child{text-align:left}.good{color:#047857;font-weight:600}.bad{color:#be123c;font-weight:600}
  .verdict{background:#f0fdfa;border-left:4px solid #14b8a6;padding:12px 16px;border-radius:6px}.mono{font-family:ui-monospace,monospace;font-size:12px;color:#475569}
  @media print{button{display:none}}</style></head><body>
  <div class="tag">SYNAPSE · Living Digital Twin · Medellín Centro · ${new Date(run.createdAt).toLocaleString()}</div>
  <h1>${sc?.name ?? run.scenario}</h1><p>${sc?.question ?? ''}</p>
  <div class="verdict"><b>Verdict.</b> ${v.text}</div>
  <h2>Experiment design</h2>
  <p>Baseline <b>A</b> — “${run.labelA}” vs. intervention <b>B</b> — “${run.labelB}”. ${run.a.length} replicate(s) × ${Math.round(run.duration / 60)} simulated minutes per arm,
  using common random numbers (seeds ${run.a.map((r) => r.seed).join(', ')}) so both arms face identical demand and incidents.</p>
  <p class="mono">Changed parameters: ${diff.map(([k, val]) => `${k}: ${(p as unknown as Record<string, unknown>)[k]} → ${val}`).join(' · ') || 'none'}</p>
  <h2>Results</h2><table><tr><th>KPI</th><th>A · baseline</th><th>B · intervention</th><th>Δ</th></tr>
  ${rows.map((r) => `<tr><td>${r.label} ${r.unit ? `(${r.unit})` : ''}</td><td>${fmtKpi(r.key, r.a)}${r.sdA ? ` ± ${fmtKpi(r.key, r.sdA)}` : ''}</td><td>${fmtKpi(r.key, r.b)}${r.sdB ? ` ± ${fmtKpi(r.key, r.sdB)}` : ''}</td><td class="${r.better === null ? '' : r.better ? 'good' : 'bad'}">${r.better === null ? '≈' : `${r.delta > 0 ? '+' : ''}${(r.delta * 100).toFixed(1)}%`}</td></tr>`).join('')}
  </table>
  <h2>Method</h2><p>Agent-based simulation on the OpenStreetMap road network of Medellín Centro (IDM car-following, A* routing, max-pressure or fixed-time signals,
  ETA-minimising emergency dispatch, substation hazard model). Synthetic demand; results compare strategies and are not calibrated forecasts.</p>
  <p class="mono">Parameters A: ${JSON.stringify(p)}</p>
  <button onclick="print()">Print / save as PDF</button></body></html>`
  const w = window.open('', '_blank')
  if (w) {
    w.document.write(html)
    w.document.close()
  }
}

export function pushRun(run: LabRun) {
  const lab = useUI.getState().lab
  const runs = [...lab.runs, run].slice(-8)
  useUI.setState({ lab: { ...lab, runs } })
  saveRuns(runs)
}
