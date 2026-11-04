import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { api } from '../cloud'
import { LAB_KPIS, compare, download, fmtKpi, seriesOf, verdict } from '../lab'
import { scenarioById } from '../sim/scenarios'
import { cityById } from '../sim/cities'
import { runtime } from '../runtime'
import type { LabRun } from '../store'
import { Legend, LineChart } from './Charts'
import { Icon } from './Icons'

/** Side-by-side comparison of the intervention arms of two experiments
 *  ("two versions of the city"). Works offline; when both runs live in the
 *  cloud the API adds Welch t-tests computed server-side. */
interface Pick { run: LabRun; cloudId?: number }
interface CompareState {
  picks: Pick[]
  open: boolean
  toggle: (p: Pick) => void
  clear: () => void
}

export const useCompare = create<CompareState>((set, get) => ({
  picks: [],
  open: false,
  toggle: (p) => {
    const key = (x: Pick) => x.cloudId ?? x.run.id
    const has = get().picks.some((x) => key(x) === key(p))
    const picks = has ? get().picks.filter((x) => key(x) !== key(p)) : [...get().picks, p].slice(-2)
    set({ picks, open: picks.length === 2 })
  },
  clear: () => set({ picks: [], open: false }),
}))

export function isPicked(run: LabRun, cloudId?: number) {
  return useCompare.getState().picks.some((p) => (cloudId != null ? p.cloudId === cloudId : p.run.id === run.id && p.cloudId == null))
}

export function CompareToggle({ run, cloudId }: { run: LabRun | (() => Promise<LabRun>); cloudId?: number }) {
  const picks = useCompare((s) => s.picks)
  const [loading, setLoading] = useState(false)
  const picked = picks.some((p) => (cloudId != null ? p.cloudId === cloudId : typeof run !== 'function' && p.run.id === run.id && p.cloudId == null))
  return (
    <button className={`btn small ${picked ? 'active' : ''}`} disabled={loading} onClick={async (e) => {
      e.stopPropagation()
      setLoading(true)
      try {
        const r = typeof run === 'function' ? await run() : run
        useCompare.getState().toggle({ run: r, cloudId })
      } finally {
        setLoading(false)
      }
    }}>
      {loading ? '…' : picked ? `✓ Selected ${picks.length}/2` : 'Compare'}
    </button>
  )
}

interface ServerStat { kpi: string; p_value: number | null }

export function CompareModal() {
  const { picks, open, clear } = useCompare()
  const [metric, setMetric] = useState<'congestion' | 'speed' | 'throughput' | 'power'>('congestion')
  const [server, setServer] = useState<{ stats: ServerStat[]; note: string } | null>(null)
  const [r1, r2] = picks
  useEffect(() => {
    setServer(null)
    if (open && r1?.cloudId != null && r2?.cloudId != null) {
      api<{ stats: ServerStat[]; note: string }>(`/api/runs/compare?a=${r1.cloudId}&b=${r2.cloudId}`).then(setServer).catch(() => setServer(null))
    }
  }, [open, r1, r2])
  if (!open || !r1 || !r2) return null

  const synthetic: LabRun = { ...r1.run, a: r1.run.b, b: r2.run.b, labelA: r1.run.labelB, labelB: r2.run.labelB }
  const rows = compare(synthetic, LAB_KPIS)
  const v = verdict(synthetic)
  const seedsA = r1.run.b.map((r) => r.seed).join(',')
  const seedsB = r2.run.b.map((r) => r.seed).join(',')
  const warnings: string[] = []
  if ((r1.run.city ?? 'medellin') !== (r2.run.city ?? 'medellin')) warnings.push('Different cities — the road networks are not the same, so compare trends rather than absolute numbers.')
  else if (r1.run.scenario !== r2.run.scenario) warnings.push('Different scenarios — you are comparing different situations, not only different decisions.')
  if (r1.run.duration !== r2.run.duration) warnings.push('Different simulated durations.')
  if (seedsA !== seedsB) warnings.push('Different seeds: the comparison is not paired, so random variation is included.')
  const name = (p: Pick) => `${cityById(p.run.city ?? 'medellin').name} · ${(p.run.city ?? 'medellin') === runtime.city.id ? scenarioById(p.run.scenario)?.name ?? p.run.scenario : p.run.scenario}`
  const pval = (k: string) => server?.stats.find((s) => s.kpi === k)?.p_value
  const exportCsv = () => {
    const lines = ['kpi,unit,run1,run2,delta_pct,winner' + (server ? ',p_value' : '')]
    for (const r of rows) lines.push([r.label, r.unit, r.a.toFixed(4), r.b.toFixed(4), (r.delta * 100).toFixed(2), r.better === null ? 'tie' : r.better ? 'run2' : 'run1', ...(server ? [pval(r.key)?.toFixed(4) ?? ''] : [])].join(','))
    download('synapse-comparison.csv', lines.join('\n'), 'text/csv')
  }

  const Card = ({ p, n, color }: { p: Pick; n: number; color: string }) => (
    <div className="card" style={{ marginTop: 0, borderColor: color + '66' }}>
      <div className="row" style={{ gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: color }} /><span className="dim" style={{ fontSize: 10, letterSpacing: '.14em' }}>RUN {n}{p.cloudId != null ? ' · CLOUD' : ' · LOCAL'}</span></div>
      <div style={{ fontWeight: 600, marginTop: 4 }}>{p.run.labelB}</div>
      <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{name(p)} · {p.run.duration / 60} min · seeds {p.run.b.map((r) => r.seed).join(', ')}</div>
    </div>
  )

  return (
    <div className="modal-back" onClick={clear}>
      <div className="modal glass" style={{ width: 'min(860px, 94vw)' }} onClick={(e) => e.stopPropagation()}>
        <div className="between">
          <div>
            <h2 style={{ margin: 0 }}>Compare experiments</h2>
            <div className="dim" style={{ fontSize: 12 }}>Intervention arm of each run, KPI by KPI — two versions of the city side by side.</div>
          </div>
          <button className="icon-btn" onClick={clear} aria-label="Close"><Icon.close /></button>
        </div>
        <div className="grid2" style={{ margin: '16px 0 10px' }}>
          <Card p={r1} n={1} color="#22d3ee" />
          <Card p={r2} n={2} color="#f472b6" />
        </div>
        {warnings.map((w) => <div key={w} className="notice">{w}</div>)}
        {!warnings.length && <div className="notice" style={{ color: 'var(--green)', borderColor: 'var(--green)' }}>Same scenario, duration and seeds — a paired comparison under identical demand.</div>}

        <div className="card" style={{ margin: '12px 0', borderColor: v.winner === 'tie' ? 'var(--line-2)' : 'rgba(52,211,153,.5)' }}>
          <span className={`chip ${v.winner === 'tie' ? 'amber' : 'green'}`}>{v.winner === 'tie' ? 'No clear winner' : v.winner === 'B' ? 'Run 2 performs better' : 'Run 1 performs better'}</span>
          <div style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.5 }}>{v.text.replace(/"([^"]+)" outperforms the baseline/, '"$1" (run 2) outperforms run 1').replace(/"([^"]+)" makes things worse/, '"$1" (run 2) is worse than run 1')}</div>
        </div>

        <div className="grid2" style={{ alignItems: 'start' }}>
          <table className="cmp">
            <thead><tr><th>KPI</th><th>Run 1</th><th>Run 2</th><th>Δ</th>{server && <th title="Welch t-test, two-sided">p</th>}</tr></thead>
            <tbody>
              {rows.map((r) => {
                const p = pval(r.key)
                return (
                  <tr key={r.key}>
                    <td>{r.label}{r.unit && <span className="dim"> {r.unit}</span>}</td>
                    <td>{fmtKpi(r.key, r.a)}</td>
                    <td>{fmtKpi(r.key, r.b)}</td>
                    <td className={r.better === null ? 'dim' : r.better ? 'up' : 'down'}>{r.better === null ? '≈' : `${r.delta > 0 ? '+' : ''}${(r.delta * 100).toFixed(1)}%`}</td>
                    {server && <td className={p != null && p < 0.05 ? 'up' : 'dim'}>{p == null ? '—' : p < 0.001 ? '<.001' : p.toFixed(3)}</td>}
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div>
            <div className="seg" style={{ marginBottom: 6 }}>
              {(['congestion', 'speed', 'throughput', 'power'] as const).map((m) => <button key={m} className={metric === m ? 'on' : ''} onClick={() => setMetric(m)}>{m === 'congestion' ? 'delay' : m}</button>)}
            </div>
            <LineChart unit="sim" fmt={(x) => x.toFixed(0)} series={[
              { name: 'run 1 baseline', color: '#22d3ee', dashed: true, points: seriesOf(r1.run.a, metric) },
              { name: 'run 2 baseline', color: '#f472b6', dashed: true, points: seriesOf(r2.run.a, metric) },
              { name: 'run 1', color: '#22d3ee', points: seriesOf(r1.run.b, metric) },
              { name: 'run 2', color: '#f472b6', points: seriesOf(r2.run.b, metric) },
            ]} />
            <Legend items={[{ name: 'run 1', color: '#22d3ee' }, { name: 'run 2', color: '#f472b6' }, { name: 'their baselines', color: '#9aa8c7', dashed: true }]} />
          </div>
        </div>
        <div className="between" style={{ marginTop: 14 }}>
          <span className="dim" style={{ fontSize: 11 }}>{server ? `Server: ${server.note}` : r1.cloudId != null && r2.cloudId != null ? 'Fetching server statistics…' : 'Save both runs to the cloud to add server-side significance tests.'}</span>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn small" onClick={exportCsv}>Export CSV</button>
            <button className="btn small primary" onClick={clear}>Done</button>
          </div>
        </div>
      </div>
    </div>
  )
}
